// Expo's default config already understands pnpm/yarn workspaces (SDK 52+).
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
