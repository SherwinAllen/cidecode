// fetchAlexaActivity.js
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
require('dotenv').config({ 
  path: path.resolve(__dirname, '.env'),
  quiet: true
});

// Get credentials from environment variables
const AMAZON_EMAIL = process.env.AMAZON_EMAIL;
const AMAZON_PASSWORD = process.env.AMAZON_PASSWORD;

if (!AMAZON_EMAIL || !AMAZON_PASSWORD) {
  console.error('Error: Please set AMAZON_EMAIL and AMAZON_PASSWORD environment variables.');
  process.exit(1);
}

// Generate a unique hash for current credentials
function generateCredentialsHash(email, password) {
  return crypto.createHash('sha256').update(`${email}:${password}`).digest('hex').substring(0, 16);
}

const currentCredentialsHash = generateCredentialsHash(AMAZON_EMAIL, AMAZON_PASSWORD);

// URLs for Amazon homepage and Alexa activity page
const activityUrl = 'https://www.amazon.in/alexa-privacy/apd/rvh';

// Profile management functions
function getProfilePath() {
  return path.join(__dirname, 'chrome-user-data');
}

function getCredentialsMarkerPath() {
  return path.join(getProfilePath(), 'credentials.marker');
}

function shouldUseExistingProfile() {
  const profilePath = getProfilePath();
  const markerPath = getCredentialsMarkerPath();
  
  if (!fs.existsSync(profilePath)) {
    return false;
  }
  
  if (!fs.existsSync(markerPath)) {
    return false;
  }
  
  try {
    const storedHash = fs.readFileSync(markerPath, 'utf8').trim();
    return storedHash === currentCredentialsHash;
  } catch (error) {
    console.warn('Could not read credentials marker:', error.message);
    return false;
  }
}

function cleanupProfileIfNeeded() {
  if (!shouldUseExistingProfile()) {
    const profilePath = getProfilePath();
    if (fs.existsSync(profilePath)) {
      console.log(`Credentials changed or profile invalid. Removing old profile: ${profilePath}`);
      try {
        fs.rmSync(profilePath, { recursive: true, force: true });
        console.log('Old profile removed successfully');
      } catch (error) {
        console.warn('Failed to remove old profile:', error.message);
      }
    }
    
    fs.mkdirSync(profilePath, { recursive: true });
    
    const markerPath = getCredentialsMarkerPath();
    try {
      fs.writeFileSync(markerPath, currentCredentialsHash, 'utf8');
      console.log('Created new profile with current credentials');
    } catch (error) {
      console.warn('Could not create credentials marker:', error.message);
    }
  } else {
    console.log('Using existing profile with matching credentials');
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Check if we're on target page
async function isOnTargetPage(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    return currentUrl.includes('/alexa-privacy/apd/');
  } catch (error) {
    return false;
  }
}

// Check if we're on 2FA/OTP page
async function isOn2FAPage(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    
    // Check for OTP/2FA indicators
    const otpIndicators = [
      "//*[contains(text(), 'Enter OTP')]",
      "//*[contains(text(), 'One Time Password')]",
      "//*[contains(text(), 'verification code')]",
      "//*[contains(text(), 'Two-Step Verification')]",
      "//*[contains(text(), 'approval')]",
      '#auth-mfa-otpcode',
      'input[name="otpCode"]',
      'input[name="code"]'
    ];
    
    // Check for OTP input fields
    const otpInputSelectors = [
      '#auth-mfa-otpcode',
      'input[name="otpCode"]',
      'input[name="code"]',
      'input[type="tel"]',
      'input[inputmode="numeric"]'
    ];
    
    for (const sel of otpInputSelectors) {
      const elements = await driver.findElements(By.css(sel));
      if (elements.length > 0) {
        return true;
      }
    }
    
    // Check for OTP text indicators
    for (const xpath of otpIndicators) {
      try {
        const elements = await driver.findElements(By.xpath(xpath));
        if (elements.length > 0) {
          return true;
        }
      } catch (e) {}
    }
    
    return currentUrl.includes('/ap/') && 
           (currentUrl.includes('mfa') || 
            currentUrl.includes('otp') || 
            currentUrl.includes('verify'));
    
  } catch (error) {
    return false;
  }
}

// Wait for redirection to target page after 2FA
async function waitForRedirectAfter2FA(driver, timeout = 120000) {
  console.log('⏳ Waiting for automatic redirection to activity page after 2FA...');
  
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      // Check if we're on target page
      if (await isOnTargetPage(driver)) {
        console.log('✅ Automatic redirection detected! Now on target page.');
        return true;
      }
      
      // Check if we're still on 2FA page
      if (!await isOn2FAPage(driver)) {
        // If we're not on 2FA page and not on target page, we might be in transition
        console.log('🔄 2FA completed, waiting for final redirection...');
        await sleep(2000);
        continue;
      }
      
      // Still on 2FA page, wait a bit
      await sleep(3000);
      
    } catch (error) {
      // If there's an error checking the page, wait and continue
      await sleep(3000);
    }
  }
  
  console.log('❌ Timeout waiting for automatic redirection after 2FA');
  return false;
}

// NEW: Check if this is truly a re-authentication scenario
async function isTrueReAuthScenario(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    
    // Must be on an Amazon authentication page
    if (!currentUrl.includes('/ap/')) {
      return false;
    }
    
    // Check for password field
    const hasPasswordField = await driver.findElements(By.css('input[type="password"]'))
      .then(elements => elements.length > 0);
    
    if (!hasPasswordField) {
      return false;
    }
    
    // Check if user email is already displayed (indicating partial session)
    const userEmailDisplayed = await driver.findElements(By.xpath(`//*[contains(text(), "${AMAZON_EMAIL}")]`))
      .then(elements => elements.length > 0);
    
    // Check for "Hello, [name]" or similar session indicators
    const sessionIndicators = [
      "//*[contains(text(), 'Hello,')]",
      "//*[contains(text(), 'Welcome,')]",
      "//*[contains(text(), 'signed in as')]"
    ];
    
    let hasSessionIndicator = false;
    for (const xpath of sessionIndicators) {
      const elements = await driver.findElements(By.xpath(xpath));
      if (elements.length > 0) {
        hasSessionIndicator = true;
        break;
      }
    }
    
    // True re-auth: we have password field AND some session indicator
    return hasPasswordField && (userEmailDisplayed || hasSessionIndicator);
    
  } catch (error) {
    return false;
  }
}

// OPTIMIZED: Check if we need full login (more comprehensive)
async function needsFullLogin(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    
    // If we're already on target page, no login needed
    if (await isOnTargetPage(driver)) {
      return false;
    }
    
    // Check for email field (strong indicator of full login)
    const emailSelectors = [
      '#ap_email',
      'input[name="email"]',
      'input[type="email"]',
      '#ap_email_login'
    ];
    
    for (const sel of emailSelectors) {
      const elements = await driver.findElements(By.css(sel));
      for (const element of elements) {
        if (await element.isDisplayed()) {
          console.log('🔐 Found email field - full login required');
          return true;
        }
      }
    }
    
    // Check if we're on a clear login page (not re-auth)
    const loginPageIndicators = [
      "//*[contains(text(), 'Sign in')]",
      "//*[contains(text(), 'Login')]",
      "//*[contains(text(), 'Create account')]"
    ];
    
    let hasLoginPageIndicator = false;
    for (const xpath of loginPageIndicators) {
      const elements = await driver.findElements(By.xpath(xpath));
      if (elements.length > 0) {
        hasLoginPageIndicator = true;
        break;
      }
    }
    
    // If we have login page indicators but no session indicators, it's likely full login
    if (hasLoginPageIndicator && !await isTrueReAuthScenario(driver)) {
      console.log('🔐 Login page detected - full login required');
      return true;
    }
    
    return false;
  } catch (error) {
    // If we can't determine, assume full login for safety
    return true;
  }
}

// Handle re-authentication
async function handleReAuth(driver) {
  console.log('=== STARTING RE-AUTHENTICATION ===');
  
  try {
    await sleep(3000);
    
    // Wait for password field to be interactable
    const passwordSelectors = [
      'input[name="password"][type="password"]',
      '#ap_password', 
      'input[type="password"]'
    ];
    
    let passwordField = null;
    for (const sel of passwordSelectors) {
      try {
        await driver.wait(until.elementLocated(By.css(sel)), 10000);
        const elements = await driver.findElements(By.css(sel));
        for (const element of elements) {
          if (await element.isDisplayed() && await element.isEnabled()) {
            passwordField = element;
            break;
          }
        }
        if (passwordField) break;
      } catch (e) {}
    }
    
    if (!passwordField) {
      console.error('❌ Could not find interactable password field for re-auth');
      return false;
    }
    
    await sleep(1000);
    
    try {
      await driver.executeScript("arguments[0].value = '';", passwordField);
    } catch (e) {
      try {
        await passwordField.clear();
      } catch (clearError) {
        console.log('Could not clear field, continuing...');
      }
    }
    
    await passwordField.sendKeys(AMAZON_PASSWORD);
    console.log('✅ Password entered');
    
    // Find and click submit button
    const submitSelectors = [
      '#signInSubmit',
      'input[type="submit"]',
      'button[type="submit"]',
      'input[value="Sign in"]',
      'button[contains(text(), "Sign in")]',
      '.a-button-input[type="submit"]'
    ];
    
    let submitButton = null;
    for (const sel of submitSelectors) {
      try {
        const elements = await driver.findElements(By.css(sel));
        for (const element of elements) {
          if (await element.isDisplayed() && await element.isEnabled()) {
            submitButton = element;
            break;
          }
        }
        if (submitButton) break;
      } catch (e) {}
    }
    
    if (submitButton) {
      await submitButton.click();
      console.log('✅ Submit button clicked');
    } else {
      await passwordField.sendKeys('\n');
      console.log('✅ Enter key pressed');
    }
    
    // Wait for result and handle potential 2FA
    console.log('Waiting for re-authentication result...');
    await sleep(8000);
    
    // Check if we need 2FA
    if (await isOn2FAPage(driver)) {
      console.log('🔐 2FA detected in re-authentication flow...');
      console.log('Please complete 2FA/OTP in the browser');
      const redirectSuccess = await waitForRedirectAfter2FA(driver);
      return redirectSuccess;
    }
    
    // Check if we're now on the target page
    if (await isOnTargetPage(driver)) {
      console.log('✅ Re-authentication successful! Reached target page.');
      return true;
    } else {
      console.log('❌ Re-authentication may have failed - not on target page');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error during re-authentication:', error);
    return false;
  }
}

// Perform full authentication
async function performFullAuthentication(driver) {
  console.log('=== STARTING FULL AUTHENTICATION ===');
  
  try {
    // We're already on the login page from activityURL redirect
    await sleep(3000);
    
    // Wait for and enter email
    const emailSelectors = [
      '#ap_email',
      'input[name="email"]',
      'input[type="email"]',
      '#ap_email_login'
    ];
    
    let emailField = null;
    for (const sel of emailSelectors) {
      try {
        await driver.wait(until.elementLocated(By.css(sel)), 10000);
        const elements = await driver.findElements(By.css(sel));
        for (const element of elements) {
          if (await element.isDisplayed() && await element.isEnabled()) {
            emailField = element;
            break;
          }
        }
        if (emailField) break;
      } catch (e) {}
    }
    
    if (!emailField) {
      console.error('❌ Could not find email field');
      return false;
    }
    
    await emailField.clear();
    await emailField.sendKeys(AMAZON_EMAIL);
    console.log('✅ Entered email');
    
    // Click continue or press enter
    const continueSelectors = [
      '#continue',
      'input[type="submit"]',
      'button[type="submit"]',
      '.a-button-input[type="submit"]'
    ];
    
    let continueButton = null;
    for (const sel of continueSelectors) {
      try {
        const elements = await driver.findElements(By.css(sel));
        for (const element of elements) {
          if (await element.isDisplayed() && await element.isEnabled()) {
            continueButton = element;
            break;
          }
        }
        if (continueButton) break;
      } catch (e) {}
    }
    
    if (continueButton) {
      await continueButton.click();
      console.log('✅ Continue button clicked');
    } else {
      await emailField.sendKeys('\n');
      console.log('✅ Enter key pressed for continue');
    }
    
    await sleep(3000);
    
    // Enter password
    const passwordSelectors = [
      '#ap_password',
      'input[name="password"]',
      'input[type="password"]'
    ];
    
    let passwordField = null;
    for (const sel of passwordSelectors) {
      try {
        await driver.wait(until.elementLocated(By.css(sel)), 10000);
        const elements = await driver.findElements(By.css(sel));
        for (const element of elements) {
          if (await element.isDisplayed() && await element.isEnabled()) {
            passwordField = element;
            break;
          }
        }
        if (passwordField) break;
      } catch (e) {}
    }
    
    if (!passwordField) {
      console.error('❌ Could not find password field');
      return false;
    }
    
    await passwordField.clear();
    await passwordField.sendKeys(AMAZON_PASSWORD);
    console.log('✅ Entered password');
    
    // Click sign-in
    const signInSelectors = [
      '#signInSubmit',
      'input[type="submit"]',
      'button[type="submit"]',
      'input[value="Sign in"]'
    ];
    
    let signInButton = null;
    for (const sel of signInSelectors) {
      try {
        const elements = await driver.findElements(By.css(sel));
        for (const element of elements) {
          if (await element.isDisplayed() && await element.isEnabled()) {
            signInButton = element;
            break;
          }
        }
        if (signInButton) break;
      } catch (e) {}
    }
    
    if (signInButton) {
      await signInButton.click();
      console.log('✅ Sign-in button clicked');
    } else {
      await passwordField.sendKeys('\n');
      console.log('✅ Enter key pressed for sign-in');
    }
    
    // Wait for login to complete and handle 2FA automatically
    console.log('Waiting for login to complete...');
    await sleep(10000);
    
    // Check if we need 2FA/OTP
    if (await isOn2FAPage(driver)) {
      console.log('🔐 2FA/OTP authentication required...');
      console.log('Please complete the 2FA/OTP verification in the browser');
      console.log('The script will automatically detect when you are redirected to the activity page');
      
      // Wait for automatic redirection after 2FA completion
      const redirectSuccess = await waitForRedirectAfter2FA(driver);
      if (redirectSuccess) {
        console.log('✅ 2FA completed and automatic redirection detected!');
        return true;
      } else {
        console.log('❌ 2FA may have failed or timed out');
        return false;
      }
    }
    
    // If no 2FA needed, check if we're on target page
    if (await isOnTargetPage(driver)) {
      console.log('✅ Full authentication completed and reached target page!');
      return true;
    } else {
      console.log('❌ Authentication may have failed - not on target page');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Full authentication failed:', error);
    return false;
  }
}

// OPTIMIZED MAIN EXECUTION FLOW
(async function fetchAlexaActivity() {
  cleanupProfileIfNeeded();
  
  const userDataDir = getProfilePath();
  const options = new chrome.Options();
  options.addArguments(`--user-data-dir=${userDataDir}`);

  console.log(`Using Chrome user-data-dir: ${userDataDir}`);

  let driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

  try {
    console.log('=== STARTING ALEXA ACTIVITY FETCH ===');
    
    // Step 1: Navigate directly to target page
    console.log('1. Navigating to Alexa activity page...');
    await driver.get(activityUrl);
    await sleep(5000);
    
    let needFinalNavigation = false;
    
    // Step 2: OPTIMIZED - Check current state with better detection
    console.log('2. Checking authentication state...');
    
    if (await isOnTargetPage(driver)) {
      console.log('✅ Already on target page!');
      // No authentication needed
    } 
    // OPTIMIZED: Check for full login FIRST (most common scenario for first run)
    else if (await needsFullLogin(driver)) {
      console.log('🔐 Full authentication required...');
      await performFullAuthentication(driver);
      needFinalNavigation = true;
    }
    // Only then check for true re-authentication
    else if (await isTrueReAuthScenario(driver)) {
      console.log('🔄 Re-authentication required...');
      const reAuthSuccess = await handleReAuth(driver);
      
      if (!reAuthSuccess || !await isOnTargetPage(driver)) {
        console.log('❌ Re-authentication failed, trying full authentication...');
        await performFullAuthentication(driver);
        needFinalNavigation = true;
      }
    }
    else {
      console.log('❓ Unknown state, assuming full authentication is needed...');
      await performFullAuthentication(driver);
      needFinalNavigation = true;
    }
    
    // Step 3: Only navigate if we're not already on the target page
    if (needFinalNavigation && !await isOnTargetPage(driver)) {
      console.log('3. Navigating to target page...');
      await driver.get(activityUrl);
      await sleep(5000);
    } else {
      console.log('3. Already on target page, skipping navigation.');
    }
    
    // Final verification
    if (await isOnTargetPage(driver)) {
      console.log('✅ Successfully reached Alexa activity page!');
      
      // Save cookies
      const cookies = await driver.manage().getCookies();
      const outputCookiesPath = path.join(__dirname, 'cookies.json');
      fs.writeFileSync(outputCookiesPath, JSON.stringify(cookies, null, 2));
      console.log(`💾 Cookies have been written to ${outputCookiesPath}`);
    } else {
      console.log('❌ Failed to reach Alexa activity page');
      const currentUrl = await driver.getCurrentUrl();
      console.log('Final URL:', currentUrl);
      await driver.quit();
      process.exit(1);
    }
  } catch (error) {
    console.error('💥 An error occurred:', error);
  } finally {
    console.log('4. Cleaning up...');
    await driver.quit();
    console.log('=== COMPLETED ===');
  }
})();