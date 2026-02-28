// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

const BASE_URL = 'http://216.238.116.106:3000';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

// Collect ALL console messages (errors, warnings, logs)
const consoleMessages = [];
const consoleErrors = [];

test.describe('Vultr VM Manager - Full Flow', () => {
  let page;
  let context;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();

    // Listen for ALL console messages
    page.on('console', (msg) => {
      const entry = {
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
        timestamp: new Date().toISOString(),
      };
      consoleMessages.push(entry);
      if (msg.type() === 'error') {
        consoleErrors.push(entry);
      }
    });

    // Listen for page errors (uncaught exceptions)
    page.on('pageerror', (err) => {
      const entry = {
        type: 'pageerror',
        text: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString(),
      };
      consoleMessages.push(entry);
      consoleErrors.push(entry);
    });

    // Listen for failed requests
    page.on('requestfailed', (request) => {
      const entry = {
        type: 'network_error',
        text: `Request failed: ${request.method()} ${request.url()} - ${request.failure()?.errorText || 'unknown'}`,
        timestamp: new Date().toISOString(),
      };
      consoleMessages.push(entry);
      consoleErrors.push(entry);
    });
  });

  test.afterAll(async () => {
    // Print ALL console messages at the end
    console.log('\n========================================');
    console.log('=== ALL CONSOLE MESSAGES ===');
    console.log('========================================');
    for (const msg of consoleMessages) {
      console.log(`[${msg.type}] ${msg.text}`);
      if (msg.stack) console.log(`  Stack: ${msg.stack}`);
      if (msg.location && msg.location.url) {
        console.log(`  Location: ${msg.location.url}:${msg.location.lineNumber}`);
      }
    }

    console.log('\n========================================');
    console.log('=== CONSOLE ERRORS ONLY ===');
    console.log('========================================');
    if (consoleErrors.length === 0) {
      console.log('No console errors detected.');
    } else {
      for (const err of consoleErrors) {
        console.log(`[${err.type}] ${err.text}`);
        if (err.stack) console.log(`  Stack: ${err.stack}`);
        if (err.location && err.location.url) {
          console.log(`  Location: ${err.location.url}:${err.location.lineNumber}`);
        }
      }
    }
    console.log(`\nTotal messages: ${consoleMessages.length}`);
    console.log(`Total errors: ${consoleErrors.length}`);
    console.log('========================================');

    await context?.close();
  });

  test('Step 1: Load initial page and screenshot login form', async () => {
    console.log('\n--- STEP 1: Navigate to app ---');
    const response = await page.goto(BASE_URL, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    console.log(`Page status: ${response?.status()}`);
    console.log(`Page URL: ${page.url()}`);

    // Wait for the auth form to appear
    await page.waitForSelector('.auth-view', { timeout: 15000 });
    await page.waitForSelector('#auth-email', { timeout: 10000 });

    // Verify login form elements exist
    const emailInput = page.locator('#auth-email');
    const passwordInput = page.locator('#auth-password');
    const submitBtn = page.locator('#auth-submit');
    const toggleLink = page.locator('#auth-toggle');

    await expect(emailInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
    await expect(submitBtn).toBeVisible();
    await expect(toggleLink).toBeVisible();

    // Verify it says "Entrar" (Login mode)
    await expect(submitBtn).toHaveText('Entrar');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '01-login-form.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: 01-login-form.png');
  });

  test('Step 2: Toggle to Register mode (Cadastre-se)', async () => {
    console.log('\n--- STEP 2: Toggle to Register ---');

    // Click the toggle link to switch to register mode
    const toggleLink = page.locator('#auth-toggle');
    await expect(toggleLink).toContainText('Cadastre-se');
    await toggleLink.click();

    // Wait for confirm password field to appear
    const confirmGroup = page.locator('#confirm-group');
    await expect(confirmGroup).toBeVisible();

    // Verify submit button now says "Cadastrar"
    const submitBtn = page.locator('#auth-submit');
    await expect(submitBtn).toHaveText('Cadastrar');

    // Verify toggle text changed
    await expect(toggleLink).toContainText('Ja tem conta');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '02-register-form.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: 02-register-form.png');
  });

  test('Step 3: Fill registration form and submit', async () => {
    console.log('\n--- STEP 3: Fill and submit registration ---');

    const emailInput = page.locator('#auth-email');
    const passwordInput = page.locator('#auth-password');
    const confirmInput = page.locator('#auth-confirm');
    const submitBtn = page.locator('#auth-submit');

    // Clear any existing values and fill form
    await emailInput.fill('playwright@test.com');
    await passwordInput.fill('test123456');
    await confirmInput.fill('test123456');

    // Screenshot with form filled
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '03-register-form-filled.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: 03-register-form-filled.png');

    // Click submit
    await submitBtn.click();

    // Wait for either: dashboard to load OR an error to appear
    // The app will register, then auto-login, then call loadApp()
    try {
      // Wait for navigation to dashboard (nav actions should render with user email)
      await page.waitForFunction(
        () => {
          const nav = document.getElementById('nav-actions');
          const authError = document.getElementById('auth-error');
          // Either dashboard loaded (nav has user email) or error showed
          return (nav && nav.textContent.includes('@')) ||
                 (authError && authError.style.display === 'block');
        },
        { timeout: 20000 }
      );
    } catch (e) {
      console.log('Timeout waiting for navigation. Taking screenshot of current state.');
    }

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '04-after-register-submit.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: 04-after-register-submit.png');

    // Check if there was an auth error (e.g., user already exists)
    const authError = page.locator('#auth-error');
    const errorVisible = await authError.isVisible().catch(() => false);

    if (errorVisible) {
      const errorText = await authError.textContent();
      console.log(`Registration error: ${errorText}`);

      // If user already exists, try logging in instead
      if (errorText && (errorText.includes('existe') || errorText.includes('already') || errorText.includes('exists'))) {
        console.log('User already exists. Switching to login mode...');

        // Toggle back to login
        const toggleLink = page.locator('#auth-toggle');
        await toggleLink.click();
        await page.waitForTimeout(500);

        // Re-fill login form
        await page.locator('#auth-email').fill('playwright@test.com');
        await page.locator('#auth-password').fill('test123456');

        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, '04b-login-form-filled.png'),
          fullPage: true,
        });
        console.log('Screenshot saved: 04b-login-form-filled.png');

        // Submit login
        await page.locator('#auth-submit').click();

        try {
          await page.waitForFunction(
            () => {
              const nav = document.getElementById('nav-actions');
              return nav && nav.textContent.includes('@');
            },
            { timeout: 20000 }
          );
        } catch (e) {
          console.log('Timeout waiting for login. Taking screenshot.');
        }

        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, '04c-after-login.png'),
          fullPage: true,
        });
        console.log('Screenshot saved: 04c-after-login.png');
      }
    }
  });

  test('Step 4: Verify dashboard loaded', async () => {
    console.log('\n--- STEP 4: Verify dashboard ---');

    // Check if we are on the dashboard
    const navText = await page.locator('#nav-actions').textContent();
    console.log(`Nav content: ${navText}`);

    const appContent = await page.locator('#app').textContent();
    console.log(`App content (first 200 chars): ${appContent.substring(0, 200)}`);

    // Look for dashboard indicators
    const hasUserEmail = navText.includes('playwright@test.com');
    const hasNovaVM = navText.includes('Nova VM');
    const hasSair = navText.includes('Sair');

    console.log(`Has user email in nav: ${hasUserEmail}`);
    console.log(`Has Nova VM button: ${hasNovaVM}`);
    console.log(`Has Sair button: ${hasSair}`);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '05-dashboard.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: 05-dashboard.png');
  });

  test('Step 5: Click + Nova VM button', async () => {
    console.log('\n--- STEP 5: Click + Nova VM ---');

    // Find and click the "+ Nova VM" button
    const novaVMBtn = page.locator('button', { hasText: '+ Nova VM' });
    const btnVisible = await novaVMBtn.isVisible().catch(() => false);
    console.log(`Nova VM button visible: ${btnVisible}`);

    if (btnVisible) {
      await novaVMBtn.click();

      // Wait for create form to appear
      try {
        await page.waitForSelector('.create-view', { timeout: 10000 });
        console.log('Create view loaded successfully.');
      } catch (e) {
        console.log('Create view did not appear. Checking state...');
      }

      await page.waitForTimeout(1500);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, '06-create-vm-form.png'),
        fullPage: true,
      });
      console.log('Screenshot saved: 06-create-vm-form.png');

      // Inspect the create form elements
      const formElements = await page.evaluate(() => {
        const elements = {};
        elements.label = !!document.getElementById('f-label');
        elements.count = !!document.getElementById('f-count');
        elements.region = !!document.getElementById('f-region');
        elements.os = !!document.getElementById('f-os');
        elements.plan = !!document.getElementById('f-plan');
        elements.installClaude = !!document.getElementById('f-install-claude');
        elements.password = !!document.getElementById('f-password');
        elements.toggleWindows = !!document.getElementById('toggle-windows');
        elements.toggleLinux = !!document.getElementById('toggle-linux');
        return elements;
      });
      console.log('Create form elements:', JSON.stringify(formElements, null, 2));
    } else {
      console.log('Nova VM button NOT visible. Taking screenshot of current state.');
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, '06-no-nova-vm-button.png'),
        fullPage: true,
      });
    }
  });

  test('Step 6: Final console error report', async () => {
    console.log('\n--- STEP 6: Final Console Error Report ---');

    // Wait a moment for any remaining async errors
    await page.waitForTimeout(2000);

    // Take a final screenshot
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '07-final-state.png'),
      fullPage: true,
    });
    console.log('Screenshot saved: 07-final-state.png');

    // Report counts
    console.log(`\nTotal console messages captured: ${consoleMessages.length}`);
    console.log(`Total console errors captured: ${consoleErrors.length}`);

    // Categorize errors
    const pageErrors = consoleErrors.filter(e => e.type === 'pageerror');
    const jsErrors = consoleErrors.filter(e => e.type === 'error');
    const networkErrors = consoleErrors.filter(e => e.type === 'network_error');

    console.log(`  - Page errors (uncaught exceptions): ${pageErrors.length}`);
    console.log(`  - Console.error calls: ${jsErrors.length}`);
    console.log(`  - Network failures: ${networkErrors.length}`);
  });
});
