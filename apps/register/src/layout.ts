import { useWindowDimensions } from "react-native";

/**
 * Screen-size buckets. `compact` covers handheld POS (PAX A920, Sunmi V2/V3),
 * phones, and tablets in portrait; wide layouts are tablets/desktop POS in landscape.
 */
export function useLayout() {
  const { width, height } = useWindowDimensions();
  return {
    width,
    height,
    compact: width < 840,
    narrow: width < 600,
    /** Width for a dialog that wants `ideal` but must fit small screens. */
    dialog: (ideal: number) => Math.min(ideal, width - 24),
  };
}
