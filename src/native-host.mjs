#!/usr/bin/env node

const { startNativeHostRuntime } = await import('../build/ts/native/native-host-runtime.js');

startNativeHostRuntime();
