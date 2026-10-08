// Expo config. Works on iPad and Android: tablets, phones, and Android POS
// hardware (Sunmi, iMin, PAX, Elo), in portrait or landscape.
//
// MYPOS_ALLOW_HTTP=1 allows plain-http API servers on the store network.
// Android blocks cleartext HTTP by default; leave this off when the API is
// served over HTTPS (recommended for anything outside a closed store LAN).
const allowHttp = process.env.MYPOS_ALLOW_HTTP === "1";

module.exports = {
  expo: {
    name: "MyPOS Register",
    slug: "mypos-register",
    version: "0.1.0",
    orientation: "default",
    userInterfaceStyle: "dark",
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.mypos.register",
      infoPlist: {
        NSCameraUsageDescription: "Scan product barcodes and card set codes.",
        ...(allowHttp ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
      },
    },
    android: {
      package: "com.mypos.register",
      permissions: ["CAMERA"],
      // Keep the cart visible above the on-screen keyboard.
      softwareKeyboardLayoutMode: "resize",
    },
    plugins: [
      "expo-secure-store",
      ["expo-camera", { cameraPermission: "Scan product barcodes." }],
      ["expo-build-properties", { android: { usesCleartextTraffic: allowHttp } }],
    ],
  },
};
