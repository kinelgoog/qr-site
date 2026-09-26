const {defineConfig, devices} = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests', timeout: 45000, expect: {timeout: 20000}, workers: 2,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure'},
  webServer: {command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory dist', url: 'http://127.0.0.1:4173', reuseExistingServer: false},
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome']}},
    {name: 'webkit-mobile', use: {...devices['iPhone 13']}},
    {name: 'firefox', use: {...devices['Desktop Firefox']}}
  ]
});
