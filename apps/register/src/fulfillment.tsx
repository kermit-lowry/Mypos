import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, Pressable, Text, Vibration, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, type FulfillmentQueue, type FulfillmentQueueOrder } from "./api";
import { useLayout } from "./layout";
import { useCan, useSession } from "./session";
import * as storage from "./storage";
import { colors, ui } from "./theme";

const POLL_MS = 20_000;
const TOAST_MS = 20_000;
const EMPTY_COUNTS: FulfillmentQueue["counts"] = { NEW: 0, ACKNOWLEDGED: 0, PICKING: 0, READY: 0, PROBLEM: 0, total: 0 };
const COUNT_KEYS = Object.keys(EMPTY_COUNTS) as (keyof typeof EMPTY_COUNTS)[];

export const CHANNEL_LABEL: Record<string, string> = { STOREFRONT: "Web", SHOPIFY: "Shopify", EBAY: "eBay", TCGPLAYER: "TCGplayer", POS: "Register" };
export const channelLabel = (c: string) => CHANNEL_LABEL[c] ?? c;

interface Queue {
  counts: FulfillmentQueue["counts"];
  latest: FulfillmentQueueOrder[];
  refresh: () => Promise<void>;
  /** When someone last looked at the queue on this register; new orders after it get announced. */
  lastSeenAt: string | null;
  markSeen: () => void;
  /** Switch to the Online tab, opening an order when given. */
  open: (orderId?: string) => void;
}

const QueueContext = createContext<Queue | null>(null);

export function useFulfillmentQueue(): Queue {
  const q = useContext(QueueContext);
  if (!q) throw new Error("useFulfillmentQueue needs a FulfillmentProvider");
  return q;
}

// ─── Sound ───────────────────────────────────────────────────────

let audio: AudioContext | null = null;
const audioCtor = () => (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

/** Browsers only let a page make sound after a tap; warm the context up on the first one. */
function armWebAudio() {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  const arm = () => {
    const Ctor = audioCtor();
    if (!Ctor) return;
    audio ??= new Ctor();
    if (audio.state === "suspended") audio.resume().catch(() => {});
  };
  document.addEventListener("pointerdown", arm, { passive: true });
  document.addEventListener("keydown", arm, { passive: true });
  return () => {
    document.removeEventListener("pointerdown", arm);
    document.removeEventListener("keydown", arm);
  };
}

/** Two short 880 Hz notes (~120 ms each) on web; a double buzz on devices. */
function chime() {
  if (Platform.OS !== "web") return Vibration.vibrate([0, 200, 100, 200]);
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    audio ??= new Ctor();
    if (audio.state === "suspended") audio.resume().catch(() => {});
    const t0 = audio.currentTime;
    for (const start of [0, 0.18]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + 0.12);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + 0.14);
    }
  } catch {
    // No audio device, or the browser refused: the toast and badge still show.
  }
}

// ─── Provider ────────────────────────────────────────────────────

/**
 * Polls the online-order queue for this store while someone is signed in,
 * and announces each new order once: a chime (or buzz) and a toast with a
 * "View" button. The header badge and the Online tab read the same counts.
 * `silent` mutes the announcements (the customer display).
 */
export function FulfillmentProvider({ children, onOpen, silent }: { children: ReactNode; onOpen: (orderId?: string) => void; silent?: boolean }) {
  const { location } = useSession();
  const can = useCan();
  const enabled = can("FULFILL_ORDERS") !== "DENY";
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [latest, setLatest] = useState<FulfillmentQueueOrder[]>([]);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  const [toasts, setToasts] = useState<FulfillmentQueueOrder[]>([]);
  // Read before the first poll so a restart doesn't announce the whole backlog.
  const [loaded, setLoaded] = useState(false);
  const seenRef = useRef<string | null>(null);
  const knownIds = useRef<Set<string> | null>(null);
  const silentRef = useRef(!!silent);
  silentRef.current = !!silent;
  const seenKey = `fulfillmentSeen:${location.id}`;

  useEffect(() => {
    let live = true;
    knownIds.current = null;
    setLoaded(false);
    storage.getItem(seenKey).then((v) => {
      if (!live) return;
      // First run at this store: only orders from now on are news.
      const at = v ?? new Date().toISOString();
      if (!v) void storage.setItem(seenKey, at);
      seenRef.current = at;
      setLastSeenAt(at);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [seenKey]);

  const refresh = useCallback(async () => {
    if (!enabled || !loaded) return;
    const params = new URLSearchParams({ locationId: location.id });
    if (seenRef.current) params.set("since", seenRef.current);
    let q: FulfillmentQueue;
    try {
      q = await api<FulfillmentQueue>("GET", `/fulfillment/queue?${params}`);
    } catch {
      return;
    }
    const rows = q?.latest ?? [];
    const next = { ...EMPTY_COUNTS, ...(q?.counts ?? {}) };
    // Same numbers, same object: the badge and tab don't re-render every poll.
    setCounts((prev) => (COUNT_KEYS.every((k) => prev[k] === next[k]) ? prev : next));
    setLatest(rows);
    const seen = seenRef.current;
    const known = knownIds.current;
    knownIds.current = new Set(rows.map((o) => o.id));
    // Announce an order once: created after the last look, and not in the previous poll.
    const after = seen ? new Date(seen).getTime() : 0;
    const fresh = rows.filter((o) => new Date(o.createdAt).getTime() > after && !known?.has(o.id) && o.fulfillmentStatus === "NEW");
    if (fresh.length === 0 || silentRef.current) return;
    chime();
    setToasts((t) => [...fresh.filter((o) => !t.some((x) => x.id === o.id)), ...t].slice(0, 3));
  }, [enabled, loaded, location.id]);

  useEffect(() => {
    if (!enabled || !loaded) return;
    void refresh();
    const t = setInterval(refresh, POLL_MS);
    // Back from the background (or the browser tab regains focus): catch up right away.
    const sub = AppState.addEventListener("change", (s) => s === "active" && void refresh());
    const disarm = armWebAudio();
    return () => {
      clearInterval(t);
      sub.remove();
      disarm();
    };
  }, [enabled, loaded, refresh]);

  const markSeen = useCallback(() => {
    const at = new Date().toISOString();
    seenRef.current = at;
    setLastSeenAt(at);
    void storage.setItem(seenKey, at);
  }, [seenKey]);

  const dismiss = (id: string) => setToasts((t) => t.filter((o) => o.id !== id));
  const open = useCallback(
    (orderId?: string) => {
      if (orderId) setToasts((t) => t.filter((o) => o.id !== orderId));
      onOpen(orderId);
    },
    [onOpen],
  );

  return (
    <QueueContext.Provider value={{ counts, latest, refresh, lastSeenAt, markSeen, open }}>
      {children}
      {toasts.length > 0 && !silent && (
        <Toasts toasts={toasts} onView={open} onDismiss={dismiss} />
      )}
    </QueueContext.Provider>
  );
}

// ─── Header badge ────────────────────────────────────────────────

/** "Online · 2 new" in the header; red while orders wait to be acknowledged. Tap to open the tab. */
export function FulfillmentBadge() {
  const { counts, open } = useFulfillmentQueue();
  const can = useCan();
  const { narrow } = useLayout();
  const n = counts.NEW;
  const live = n > 0;
  if (can("FULFILL_ORDERS") === "DENY") return null;
  return (
    <Pressable
      onPress={() => open()}
      accessibilityRole="button"
      accessibilityLabel={`Online orders, ${n} new`}
      style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, backgroundColor: live ? colors.bad : colors.panelAlt }}
    >
      <Text style={[ui.muted, { fontWeight: "600" }, live ? { color: "#ffffff" } : null]}>{narrow ? (live ? `${n} new` : "Online") : live ? `Online · ${n} new` : "Online"}</Text>
    </Pressable>
  );
}

// ─── Toasts ──────────────────────────────────────────────────────

function Toasts({ toasts, onView, onDismiss }: { toasts: FulfillmentQueueOrder[]; onView: (id: string) => void; onDismiss: (id: string) => void }) {
  const insets = useSafeAreaInsets();
  const { narrow } = useLayout();
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 8, left: narrow ? 8 : 16, right: narrow ? 8 : 16, alignItems: "center", gap: 8 }}>
      {toasts.map((o) => (
        <Toast key={o.id} order={o} onView={() => onView(o.id)} onDismiss={() => onDismiss(o.id)} />
      ))}
    </View>
  );
}

function Toast({ order: o, onView, onDismiss }: { order: FulfillmentQueueOrder; onView: () => void; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(t);
  }, []);
  const items = `${o.items} ${o.items === 1 ? "item" : "items"}`;
  return (
    <View style={[ui.panel, ui.row, { width: "100%", maxWidth: 560, gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderColor: colors.accent, borderWidth: 2 }]}>
      <View style={{ flex: 1 }}>
        <Text style={[ui.text, { fontWeight: "700" }]} numberOfLines={1}>
          New online order #{o.number}
        </Text>
        <Text style={ui.muted} numberOfLines={2}>
          {[o.customer?.name, items, o.fulfillment === "SHIP" ? "Ship" : "Pickup", channelLabel(o.channel)].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <Pressable onPress={onView} accessibilityRole="button" style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, backgroundColor: colors.primary }}>
        <Text style={{ color: colors.onPrimary, fontWeight: "600" }}>View</Text>
      </Pressable>
      <Pressable onPress={onDismiss} accessibilityRole="button" style={{ padding: 8 }}>
        <Text style={{ color: colors.link }}>Dismiss</Text>
      </Pressable>
    </View>
  );
}
