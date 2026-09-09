import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'test',testMatch:'*.browser.ts',workers:1,use:{headless:true,channel:'chromium'},timeout:30000 });
