import { formatCents } from "@mypos/shared";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { api } from "../api";
import { Button } from "../components/Button";
import { useSession } from "../session";
import { colors, ui } from "../theme";

interface EventRow {
  id: string;
  name: string;
  game: string | null;
  format: string | null;
  startsAt: string;
  capacity: number;
  entryFeeCents: number;
  _count: { registrations: number };
}

interface Roster {
  id: string;
  name: string;
  spotsLeft: number;
  roster: { registrationId: string; name: string; checkedIn: boolean; playerIds: Record<string, string> }[];
}

/** Tonight's events, rosters, and check-in. Entries are sold from the Sell tab. */
export function EventsScreen() {
  const { location } = useSession();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [roster, setRoster] = useState<Roster | null>(null);

  const load = useCallback(async () => setEvents(await api<EventRow[]>("GET", `/events?locationId=${location.id}`)), [location.id]);
  useEffect(() => {
    load();
  }, [load]);

  const open = async (id: string) => setRoster(await api<Roster>("GET", `/events/${id}`));

  return (
    <View style={{ flex: 1, flexDirection: "row", gap: 16, padding: 16 }}>
      <View style={[ui.panel, { flex: 1 }]}>
        <View style={[ui.row, { justifyContent: "space-between" }]}>
          <Text style={ui.h1}>Events</Text>
          <Button title="Refresh" kind="secondary" onPress={load} />
        </View>
        <FlatList
          data={events}
          keyExtractor={(e) => e.id}
          renderItem={({ item: e }) => (
            <Pressable onPress={() => open(e.id)} style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <Text style={ui.text}>{e.name}</Text>
              <Text style={ui.muted}>
                {new Date(e.startsAt).toLocaleString()} · {[e.game, e.format].filter(Boolean).join(" ")} · {formatCents(e.entryFeeCents)} ·{" "}
                {e._count.registrations}/{e.capacity}
              </Text>
            </Pressable>
          )}
        />
      </View>
      <View style={[ui.panel, { flex: 1 }]}>
        {roster ? (
          <>
            <Text style={ui.h1}>{roster.name}</Text>
            <Text style={ui.muted}>{roster.spotsLeft} spots left</Text>
            <FlatList
              data={roster.roster}
              keyExtractor={(r) => r.registrationId}
              renderItem={({ item: r }) => (
                <View style={[ui.row, { justifyContent: "space-between", paddingVertical: 10 }]}>
                  <View>
                    <Text style={ui.text}>{r.name}</Text>
                    <Text style={ui.muted}>{Object.entries(r.playerIds).map(([g, id]) => `${g}: ${id}`).join(" · ")}</Text>
                  </View>
                  {r.checkedIn ? (
                    <Text style={{ color: colors.good }}>Checked in</Text>
                  ) : (
                    <Button
                      title="Check in"
                      kind="secondary"
                      onPress={async () => {
                        await api("POST", `/events/registrations/${r.registrationId}/check-in`);
                        await open(roster.id);
                      }}
                    />
                  )}
                </View>
              )}
            />
          </>
        ) : (
          <Text style={ui.muted}>Select an event to see its roster</Text>
        )}
      </View>
    </View>
  );
}
