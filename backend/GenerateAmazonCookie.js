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
const homeUrl = 'https://www.amazon.in';
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

function waitForUserPrompt(promptText = 'Press Enter when you have completed the required action in the browser...') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${promptText}\n`, () => {
      rl.close();
      resolve();
    });
  });
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

// Check if re-authentication is needed
async function isReAuthPage(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    
    // Check for password field specifically for re-auth
    const passwordSelectors = [
      'input[name="password"][type="password"]',
      '#ap_password',
      'input[type="password"]'
    ];
    
    let hasPasswordField = false;
    for (const sel of passwordSelectors) {
      const elements = await driver.findElements(By.css(sel));
      if (elements.length > 0) {
        hasPasswordField = true;
        break;
      }
    }
    
    if (!hasPasswordField) {
      return false;
    }
    
    // Additional checks for re-auth context
    const reAuthIndicators = [
      "//*[contains(text(), 'Enter your password')]",
      "//*[contains(text(), 'Re-enter your password')]",
      "//*[contains(text(), 'password again')]",
      "//*[contains(text(), 'verify your password')]",
      "//*[contains(text(), 'confirm your password')]"
    ];
    
    for (const xpath of reAuthIndicators) {
      try {
        const elements = await driver.findElements(By.xpath(xpath));
        if (elements.length > 0) {
          return true;
        }
      } catch (e) {}
    }
    
    // Check if we can see the user's email
    try {
      const emailDisplay = await driver.findElements(By.xpath("//*[contains(text(), '" + AMAZON_EMAIL + "')]"));
      if (emailDisplay.length > 0) {
        return true;
      }
    } catch (e) {}
    
    // If we have a password field and we're on an Amazon auth page, it's likely re-auth
    if (currentUrl.includes('/ap/') && hasPasswordField) {
      return true;
    }
    
    return false;
    
  } catch (error) {
    return false;
  }
}

// Handle re-authentication
async function handleReAuth(driver) {
  console.log('=== STARTING RE-AUTHENTICATION ===');
  
  try {
    await sleep(2000);
    
    // Find password field
    const passwordSelectors = [
      'input[name="password"][type="password"]',
      '#ap_password', 
      'input[type="password"]'
    ];
    
    let passwordField = null;
    for (const sel of passwordSelectors) {
      try {
        const elements = await driver.findElements(By.css(sel));
        if (elements.length > 0) {
          passwordField = elements[0];
          break;
        }
      } catch (e) {}
    }
    
    if (!passwordField) {
      console.error('❌ Could not find password field for re-auth');
      return false;
    }
    
    // Clear and enter password
    await passwordField.clear();
    await passwordField.sendKeys(AMAZON_PASSWORD);
    console.log('✅ Password entered');
    
    // Find submit button
    const submitSelectors = [
      '#signInSubmit',
      'input[type="submit"]',
      'button[type="submit"]',
      'input[value="Sign in"]',
      'button[value="Sign in"]'
    ];
    
    let submitButton = null;
    for (const sel of submitSelectors) {
      try {
        const elements = await driver.findElements(By.css(sel));
        if (elements.length > 0) {
          submitButton = elements[0];
          break;
        }
      } catch (e) {}
    }
    
    if (submitButton) {
      await submitButton.click();
    } else {
      // Fallback: press Enter
      await passwordField.sendKeys('\n');
    }
    
    // Wait for result
    console.log('Waiting for re-authentication result...');
    await sleep(5000);
    
    // Check if we're now on the target page
    const currentUrl = await driver.getCurrentUrl();
    
    if (currentUrl.includes('/alexa-privacy/apd/')) {
      console.log('✅ Re-authentication successful! Reached target page.');
      return true;
    } else {
      console.log('❌ Re-authentication failed');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error during re-authentication:', error);
    return false;
  }
}

// Check if we need full login
async function needsFullLogin(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    
    // Check for email field (indicates full login needed)
    const emailSelectors = [
      '#ap_email',
      'input[name="email"]',
      'input[type="email"]'
    ];
    
    for (const sel of emailSelectors) {
      const elements = await driver.findElements(By.css(sel));
      if (elements.length > 0) {
        console.log('Found email field - full login required');
        return true;
      }
    }
    
    return false;
  } catch (error) {
    return true;
  }
}

// Perform full authentication
async function performFullAuthentication(driver) {
  console.log('=== STARTING FULL AUTHENTICATION ===');
  
  try {
    // Navigate to home first to start fresh
    await driver.get(homeUrl);
    await sleep(3000);
    
    // Look for and click sign-in link
    try {
      const signInLink = await driver.findElement(By.id('nav-link-accountList'));
      await signInLink.click();
      console.log('Clicked sign-in link');
      await sleep(3000);
    } catch (e) {
      console.log('Sign-in link not found, continuing...');
    }
    
    // Enter email
    const emailField = await driver.findElement(By.id('ap_email'));
    await emailField.clear();
    await emailField.sendKeys(AMAZON_EMAIL);
    console.log('Entered email');
    
    // Click continue
    try {
      const continueButton = await driver.findElement(By.id('continue'));
      await continueButton.click();
    } catch (e) {
      // Try pressing Enter
      await emailField.sendKeys('\n');
    }
    await sleep(3000);
    
    // Enter password
    const passwordField = await driver.findElement(By.id('ap_password'));
    await passwordField.clear();
    await passwordField.sendKeys(AMAZON_PASSWORD);
    console.log('Entered password');
    
    // Click sign-in
    const signInButton = await driver.findElement(By.id('signInSubmit'));
    await signInButton.click();
    console.log('Clicked sign-in button');
    
    // Wait for login to complete
    console.log('Waiting for login to complete...');
    await sleep(10000);
    
    // Handle potential 2FA or other challenges
    const currentUrl = await driver.getCurrentUrl();
    if (currentUrl.includes('/ap/')) {
      console.log('Additional authentication may be required');
      console.log('Please complete any CAPTCHA, OTP, or approval in the browser');
      await waitForUserPrompt('Press Enter after completing authentication in the browser...');
    }
    
    console.log('✅ Full authentication completed');
    return true;
    
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
    
    // Step 2: Check current state and handle authentication if needed
    console.log('2. Checking current state...');
    
    if (await isOnTargetPage(driver)) {
      console.log('✅ Already on target page!');
      // No authentication needed, no final navigation needed
    } 
    else if (await isReAuthPage(driver)) {
      console.log('🔄 Re-authentication required...');
      const reAuthSuccess = await handleReAuth(driver);
      
      if (!reAuthSuccess || !await isOnTargetPage(driver)) {
        console.log('❌ Re-authentication failed, trying full authentication...');
        await performFullAuthentication(driver);
        needFinalNavigation = true; // After full auth, we need to navigate to target
      }
      // If re-auth succeeded, we're already on target page - no navigation needed
    }
    else if (await needsFullLogin(driver)) {
      console.log('🔐 Full authentication required...');
      await performFullAuthentication(driver);
      needFinalNavigation = true; // After full auth, we need to navigate to target
    }
    else {
      console.log('❓ Unknown state, assuming authentication is needed...');
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
    }

  } catch (error) {
    console.error('💥 An error occurred:', error);
  } finally {
    console.log('4. Cleaning up...');
    await driver.quit();
    console.log('=== COMPLETED ===');
  }
})();