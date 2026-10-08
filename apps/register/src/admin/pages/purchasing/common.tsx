import { useEffect, useState } from "react";
import { Text, TextInput, type ViewStyle } from "react-native";
import type { Location, Product, Vendor } from "../../../api";
import { imageOf, variantLabel } from "../../../components/ProductSearch";
import { colors, ui } from "../../../theme";
import { Badge, Field } from "../../ui";

export type PoStatus = "DRAFT" | "ORDERED" | "PARTIAL" | "RECEIVED" | "CANCELLED";

export interface PoLine {
  variantId: string;
  title: string;
  detail: string;
  sku: string;
  /** The vendor's own item number, when the product is linked to them. */
  vendorSku?: string | null;
  imageUrl?: string | null;
  quantity: number;
  receivedQty: number;
  unitCostCents: number;
}

/** One delivery against an order. The list only carries id and date. */
export interface Receipt {
  id: string;
  reference?: string | null;
  receivedAt: string;
  staffId?: string | null;
  lines?: { variantId: string; quantity: number; unitCostCents: number }[];
}

export interface Po {
  id?: string;
  number?: number;
  status: PoStatus;
  vendorId: string;
  vendor?: Vendor;
  locationId: string;
  location?: Location;
  reference?: string | null;
  notes?: string | null;
  expectedAt?: string | null;
  orderedAt?: string | null;
  receivedAt?: string | null;
  createdAt?: string;
  shippingCents?: number;
  lines: PoLine[];
  receipts?: Receipt[];
}

/** What a vendor supplies, from GET /vendors/:id/products. */
export interface VendorItem {
  vendorSku: string | null;
  costCents: number | null;
  preferred: boolean;
  leadDays: number | null;
  notes: string | null;
  product: Product;
}

export const STATUS_LABEL: Record<PoStatus, string> = { DRAFT: "Draft", ORDERED: "Ordered", PARTIAL: "Partial", RECEIVED: "Received", CANCELLED: "Cancelled" };
export const statusTone = (s: PoStatus): "good" | "warn" | "muted" => (s === "RECEIVED" ? "good" : s === "ORDERED" || s === "PARTIAL" ? "warn" : "muted");
export const StatusBadge = ({ status }: { status: PoStatus }) => <Badge text={STATUS_LABEL[status]} tone={statusTone(status)} />;

/** An order as the API returns it, lines flattened for the editor. */
export const fromServer = (po: any): Po => ({
  ...po,
  lines: (po.lines ?? []).map(
    (l: any): PoLine => ({
      variantId: l.variantId,
      title: l.variant?.product?.title ?? l.title ?? l.variantId,
      detail: l.variant ? variantLabel(l.variant) : "",
      sku: l.variant?.sku ?? "",
      imageUrl: l.variant?.product ? imageOf(l.variant.product, l.variant) : null,
      quantity: l.quantity,
      receivedQty: l.receivedQty ?? 0,
      unitCostCents: l.unitCostCents,
    }),
  ),
  receipts: po.receipts ?? [],
});

export const newPo = (vendorId: string, locationId: string): Po => ({ status: "DRAFT", vendorId, locationId, shippingCents: 0, lines: [], receipts: [] });

export const qtyOf = (lines: { quantity: number }[]) => lines.reduce((a, l) => a + l.quantity, 0);
export const receivedOf = (lines: { receivedQty: number }[]) => lines.reduce((a, l) => a + l.receivedQty, 0);
export const subtotalOf = (lines: { quantity: number; unitCostCents: number }[]) => lines.reduce((a, l) => a + l.quantity * l.unitCostCents, 0);
export const totalOf = (po: Po) => subtotalOf(po.lines) + (po.shippingCents ?? 0);

/** "12.50" → 1250; blank or junk → 0. */
export const toCents = (t: string) => Math.max(0, Math.round(Number(t) * 100) || 0);
export const toInt = (t: string, min = 0) => Math.max(min, Math.floor(Number(t)) || 0);
export const dollars = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));

/** Buttons in card headers and table rows. */
export const small: ViewStyle = { minHeight: 34, paddingVertical: 5, paddingHorizontal: 12 };

/** A label over plain text, for fields this employee can't edit. */
export function ReadField({ label, value }: { label: string; value?: string | null }) {
  return (
    <Field label={label}>
      <Text style={ui.text}>{value || "—"}</Text>
    </Field>
  );
}

/** A small box in a line or table cell; reports its text when focus leaves it. */
export function CellInput({ value, onCommit, width = 80, keyboard = "default", editable = true, placeholder, tone }: { value: string; onCommit: (t: string) => void; width?: number; keyboard?: "default" | "decimal-pad" | "number-pad"; editable?: boolean; placeholder?: string; tone?: "good" }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
    setText(value);
  };
  return (
    <TextInput
      style={[ui.input, { width, paddingVertical: 6, paddingHorizontal: 10 }, tone === "good" && { borderColor: colors.good }, !editable && { color: colors.muted }]}
      value={text}
      onChangeText={setText}
      onBlur={commit}
      onSubmitEditing={commit}
      editable={editable}
      keyboardType={keyboard}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}
