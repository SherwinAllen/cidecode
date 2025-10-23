const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// NEW: Function to detect unknown 2FA page (not OTP or Push)
async function isUnknown2FAPage(driver) {
  try {
    console.log('🔍 Checking for unknown 2FA page...');
    
    // If we're on target page, it's not unknown
    if (await isOnTargetPage(driver)) {
      return false;
    }
    
    // If we're on known 2FA pages (OTP or Push), it's not unknown
    if (await isOn2FAPage(driver)) {
      const method = await detect2FAMethod(driver);
      if (method === 'OTP (SMS/Voice)' || method === 'Push Notification') {
        return false;
      }
    }
    
    // Check if we're on any Amazon authentication page that's not the target page
    const currentUrl = await driver.getCurrentUrl();
    if (currentUrl.includes('/ap/') && 
        !currentUrl.includes('/alexa-privacy/apd/') &&
        !await isOnTargetPage(driver)) {
      console.log('🔴 Detected unknown 2FA/Auth page:', currentUrl);
      return true;
    }
    
    return false;
  } catch (error) {
    console.warn('Error checking for unknown 2FA page:', error.message);
    return false;
  }
}

// NEW: Function to detect invalid email error
async function isInvalidEmailError(driver) {
  try {
    const errorSelectors = [
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'we cannot find an account with that email')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'no account found')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'invalid email')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'account not found')]",
      '.a-box-inner.a-alert-container',
      '.a-alert-content'
    ];
    
    for (const selector of errorSelectors) {
      try {
        if (selector.startsWith('//')) {
          const elements = await driver.findElements(By.xpath(selector));
          for (const element of elements) {
            const text = await element.getText();
            if (text && text.toLowerCase().includes('cannot find an account') || 
                text.toLowerCase().includes('no account found')) {
              return true;
            }
          }
        } else {
          const elements = await driver.findElements(By.css(selector));
          for (const element of elements) {
            const text = await element.getText();
            if (text && text.toLowerCase().includes('cannot find an account') || 
                text.toLowerCase().includes('no account found')) {
              return true;
            }
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // Also check page source as fallback
    const pageSource = await driver.getPageSource();
    if (pageSource.toLowerCase().includes('cannot find an account') || 
        pageSource.toLowerCase().includes('no account found')) {
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// NEW: Function to detect incorrect password error
async function isIncorrectPasswordError(driver) {
  try {
    const errorSelectors = [
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'your password is incorrect')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'incorrect password')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'wrong password')]",
      '.a-box-inner.a-alert-container',
      '.a-alert-content',
      '.a-list-item'
    ];
    
    for (const selector of errorSelectors) {
      try {
        if (selector.startsWith('//')) {
          const elements = await driver.findElements(By.xpath(selector));
          for (const element of elements) {
            const text = await element.getText();
            if (text && (text.toLowerCase().includes('password is incorrect') || 
                text.toLowerCase().includes('incorrect password'))) {
              return true;
            }
          }
        } else {
          const elements = await driver.findElements(By.css(selector));
          for (const element of elements) {
            const text = await element.getText();
            if (text && (text.toLowerCase().includes('password is incorrect') || 
                text.toLowerCase().includes('incorrect password'))) {
              return true;
            }
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // Also check page source as fallback
    const pageSource = await driver.getPageSource();
    if (pageSource.toLowerCase().includes('password is incorrect') || 
        pageSource.toLowerCase().includes('incorrect password')) {
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// IMPROVED: Function to detect OTP verification failure - MORE ACCURATE
async function isOtpVerificationFailed(driver) {
  try {
    // FIRST check if we're on target page - if yes, then OTP was successful
    if (await isOnTargetPage(driver)) {
      return false; // SUCCESS - not a failure
    }
    
    // Only check for OTP errors if we're actually on an OTP page
    const onOtpPage = await isOn2FAPage(driver);
    if (!onOtpPage) {
      return false; // If we're not on OTP page, can't have OTP failure
    }
    
    const errorSelectors = [
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'the code you entered is not valid')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'incorrect code')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'wrong code')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'invalid code')]",
      '.a-box-inner.a-alert-container',
      '.a-alert-content',
      '.a-list-item'
    ];
    
    for (const selector of errorSelectors) {
      try {
        if (selector.startsWith('//')) {
          const elements = await driver.findElements(By.xpath(selector));
          for (const element of elements) {
            const text = await element.getText();
            if (text && (text.toLowerCase().includes('code you entered is not valid') || 
                text.toLowerCase().includes('incorrect code') ||
                text.toLowerCase().includes('wrong code'))) {
              console.log('🔴 Detected OTP verification failure');
              return true;
            }
          }
        } else {
          const elements = await driver.findElements(By.css(selector));
          for (const element of elements) {
            const text = await element.getText();
            if (text && (text.toLowerCase().includes('code you entered is not valid') || 
                text.toLowerCase().includes('incorrect code') ||
                text.toLowerCase().includes('wrong code'))) {
              console.log('🔴 Detected OTP verification failure');
              return true;
            }
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // Also check page source as fallback
    const pageSource = await driver.getPageSource();
    if (pageSource.toLowerCase().includes('code you entered is not valid') || 
        pageSource.toLowerCase().includes('incorrect code') ||
        pageSource.toLowerCase().includes('wrong code')) {
      console.log('🔴 Detected OTP verification failure in page source');
      return true;
    }
    
    return false;
  } catch (error) {
    console.warn('Error checking for OTP verification failure:', error.message);
    return false;
  }
}

// NEW: Function to detect and handle authentication errors - IMPROVED
async function checkForAuthErrors(driver, context = 'general') {
  console.log(`🔍 Checking for authentication errors (context: ${context})...`);
  
  // Check for invalid email error
  if (await isInvalidEmailError(driver)) {
    console.log('❌ AUTHENTICATION ERROR: Invalid email address');
    console.log(`   The email "${AMAZON_EMAIL}" is not associated with an Amazon account`);
    return 'INVALID_EMAIL';
  }
  
  // Check for incorrect password error
  if (await isIncorrectPasswordError(driver)) {
    console.log('❌ AUTHENTICATION ERROR: Incorrect password');
    console.log('   The password provided does not match the email address');
    return 'INCORRECT_PASSWORD';
  }
  
  // NEW: Check for unknown 2FA page
  if (await isUnknown2FAPage(driver)) {
    console.log('❌ UNKNOWN 2FA PAGE: Unsupported authentication method detected');
    console.log('   This account requires additional verification that cannot be automated');
    return 'UNKNOWN_2FA_PAGE';
  }
  
  // Only check for OTP errors if we're specifically in OTP context AND not on target page
  if (context === 'otp' && !await isOnTargetPage(driver)) {
    // Check for OTP verification failure
    if (await isOtpVerificationFailed(driver)) {
      console.log('❌ OTP VERIFICATION FAILED: Incorrect OTP entered');
      return 'OTP_VERIFICATION_FAILED';
    }
  }
  
  return null;
}

// Check if we're on target page
async function isOnTargetPage(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    return currentUrl.includes('/alexa-privacy/apd/');
  } catch (error) {
    return false;
  }
}

// Enhanced function to detect push notification page
async function isOnPushNotificationPage(driver) {
  try {
    const currentUrl = await driver.getCurrentUrl();
    const pageSource = await driver.getPageSource();
    
    // Check for push notification page indicators
    const pushIndicators = [
      currentUrl.includes('/ap/cv/'),
      currentUrl.includes('transactionapprox'),
      pageSource.includes('approve the notification'),
      pageSource.includes('sent to:'),
      pageSource.includes('AmazonShopping'),
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'approve the notification')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'check your device')]"
    ];
    
    for (const indicator of pushIndicators) {
      if (typeof indicator === 'string' && indicator.startsWith('//')) {
        try {
          const elements = await driver.findElements(By.xpath(indicator));
          if (elements.length > 0) return true;
        } catch (e) {}
      } else if (indicator === true) {
        return true;
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// Enhanced 2FA method detection
async function detect2FAMethod(driver) {
  try {
    console.log('🔍 Detecting 2FA method...');
    
    const currentUrl = await driver.getCurrentUrl();
    const pageSource = await driver.getPageSource();
    
    // Check for OTP FIRST
    const otpIndicators = [
      '#auth-mfa-otpcode',
      'input[name="otpCode"]',
      'input[name="code"]',
      'input[type="tel"]',
      'input[inputmode="numeric"]',
      'input[placeholder*="code" i]',
      'input[placeholder*="otp" i]',
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'otp')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'one time password')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'verification code')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'text message')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sms')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sent a code')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sent an otp')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'enter code')]"
    ];
    
    // Check OTP indicators first
    for (const indicator of otpIndicators) {
      try {
        if (indicator.startsWith('//')) {
          const elements = await driver.findElements(By.xpath(indicator));
          if (elements.length > 0) {
            console.log('✅ Detected OTP 2FA method');
            return 'OTP (SMS/Voice)';
          }
        } else {
          const elements = await driver.findElements(By.css(indicator));
          if (elements.length > 0) {
            console.log('✅ Detected OTP 2FA method');
            return 'OTP (SMS/Voice)';
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // Only AFTER checking OTP, check for push notification
    if (await isOnPushNotificationPage(driver)) {
      console.log('✅ Detected Push Notification 2FA method');
      return 'Push Notification';
    }
    
    return 'Unknown 2FA Method';
  } catch (error) {
    console.warn('Error detecting 2FA method:', error.message);
    return 'Error detecting 2FA method';
  }
}

// Function to check if we're on any kind of 2FA page
async function isOn2FAPage(driver) {
  try {
    // Check for OTP input fields FIRST
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
    
    // Only AFTER checking OTP, check for push notification page
    if (await isOnPushNotificationPage(driver)) {
      return true;
    }
    
    const currentUrl = await driver.getCurrentUrl();
    
    // Check for 2FA text indicators
    const otpIndicators = [
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'two-step verification')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'two-factor authentication')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'verification code')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'enter code')]"
    ];
    
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

// Enhanced wait function with better push notification handling and cleanup
async function waitForRedirectAfter2FA(driver, timeout = 180000) {
  console.log('⏳ Waiting for automatic redirection to activity page after 2FA...');
  
  const startTime = Date.now();
  let lastState = '2fa_page';
  let wasOnPushPage = false;
  
  try {
    while (Date.now() - startTime < timeout) {
      try {
        const currentUrl = await driver.getCurrentUrl();
        
        // Check if we're on target page
        if (await isOnTargetPage(driver)) {
          console.log('✅ Automatic redirection detected! Now on target page.');
          return true;
        }
        
        // Check if we're on push notification page
        const onPushPage = await isOnPushNotificationPage(driver);
        if (onPushPage) {
          wasOnPushPage = true;
        }
        
        // Check if we're on any 2FA page
        const on2FAPage = await isOn2FAPage(driver);
        
        // Check if we're back on login page (error condition) - push notification failure
        const onLoginPage = await needsFullLogin(driver);
        
        // NEW: Detect push notification failure - THROW ERROR INSTEAD OF RETURNING
        if (wasOnPushPage && onLoginPage && !on2FAPage && !onPushPage) {
          console.log('❌ Push notification was denied or failed');
          if (REQUEST_ID) {
            try { 
              await postJson(`/api/internal/2fa-update/${REQUEST_ID}`, { 
                errorType: 'PUSH_DENIED',
                message: 'Sign in attempt was denied. Please try again.' 
              }); 
            } catch(e){
              console.error('Error notifying server of PUSH_DENIED:', e);
            }
          }
          // THROW THE ERROR INSTEAD OF RETURNING
          throw new Error('PUSH_NOTIFICATION_DENIED');
        }
        
        if (onPushPage) {
          if (lastState !== 'push_page') {
            console.log('📱 On push notification page - waiting for user to approve on device...');
            lastState = 'push_page';
          }
          // Stay on push notification page and wait
          await sleep(5000);
          continue;
        }
        
        if (on2FAPage) {
          if (lastState !== '2fa_page') {
            console.log('🔐 Still on 2FA page, waiting...');
            lastState = '2fa_page';
          }
          await sleep(3000);
          continue;
        }
        
        // If we're not on 2FA page and not on target page, we might be in transition
        if (!on2FAPage && !onPushPage) {
          if (lastState !== 'transition') {
            console.log('🔄 2FA completed, waiting for final redirection...');
            lastState = 'transition';
          }
          await sleep(2000);
          continue;
        }
        
      } catch (error) {
        if (error.message === 'PUSH_NOTIFICATION_DENIED') {
          console.log('🔄 Propagating PUSH_NOTIFICATION_DENIED error to main flow...');
          throw error; // Re-throw to break out of function entirely
        }
        // If there's an error checking the page, wait and continue
        console.log('⚠️ Error checking page state, continuing to wait...');
        await sleep(5000);
      }
    }
    
    console.log('❌ Timeout waiting for automatic redirection after 2FA');
    return false;
  } catch (error) {
    // Ensure any errors in this function are properly propagated
    if (error.message === 'PUSH_NOTIFICATION_DENIED') {
      throw error; // Re-throw push denial errors
    }
    console.error('Error in waitForRedirectAfter2FA:', error.message);
    throw error;
  }
}

// IMPROVED: Handle OTP submission and verification with proper state tracking
async function fillOtpAndSubmit(driver, otp) {
  try {
    console.log('Attempting to auto-fill OTP (masked) ...');
    console.log(`OTP (masked): ${otp ? otp.replace(/\d/g, '*') : ''}`);

    const otpSelectors = [
      '#auth-mfa-otpcode',
      'input[name="otpCode"]',
      'input[name="code"]',
      'input[placeholder*="code" i]',
      'input[placeholder*="otp" i]',
      'input[type="tel"]',
      'input[type="number"]',
      'input[inputmode="numeric"]'
    ];

    let filled = false;
    let inputEl = null;
    for (const sel of otpSelectors) {
      try {
        const els = await driver.findElements(By.css(sel));
        if (els.length > 0) {
          inputEl = els[0];
          await inputEl.clear().catch(()=>{});
          await inputEl.sendKeys(otp);
          filled = true;
          break;
        }
      } catch (e) { /* ignore and continue */ }
    }

    if (!filled) {
      try {
        const els = await driver.findElements(By.xpath("//input[@type='text' or @type='tel' or @type='number'][contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'code') or contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'otp')]"));
        if (els.length > 0) {
          inputEl = els[0];
          await inputEl.clear().catch(()=>{});
          await inputEl.sendKeys(otp);
          filled = true;
        }
      } catch (e) {}
    }

    if (filled && inputEl) {
      // small pause to allow page to react to typed input
      await sleep(400);

      const submitSelectors = [
        '#cvf-submit-otp-button > span > input',
        'input.a-button-input[type="submit"]',
        'button[type="submit"]',
        'input[type="submit"]'
      ];

      let clicked = false;
      for (const sel of submitSelectors) {
        try {
          const els = await driver.findElements(By.css(sel));
          if (els.length > 0) {
            try { await driver.executeScript('arguments[0].scrollIntoView(true);', els[0]); } catch(e){}
            try {
              await els[0].click();
              clicked = true;
              break;
            } catch (clickErr) {
              try {
                await driver.executeScript('arguments[0].click();', els[0]);
                clicked = true;
                break;
              } catch (jsClickErr) {}
            }
          }
        } catch (e) { /* ignore and try next */ }
      }

      if (!clicked) {
        try {
          await driver.actions().sendKeys('\n').perform();
          clicked = true;
        } catch (e) {}
      }

      if (clicked) {
        console.log('OTP auto-submitted.');
        
        // IMPROVED OTP VERIFICATION LOGIC:
        // Wait for page to process the OTP
        await sleep(3000);
        
        // STEP 1: FIRST check if we're on target page - this is the SUCCESS case
        if (await isOnTargetPage(driver)) {
          console.log('✅ OTP verification SUCCESSFUL - redirected to target page');
          
          // Clear any OTP error state on server since we succeeded
          if (REQUEST_ID) {
            try { 
              await postJson(`/api/internal/2fa-update/${REQUEST_ID}`, { 
                errorType: null,
                otpError: null,
                showOtpModal: false,
                method: 'OTP (SMS/Voice) - SUCCESS',
                message: 'OTP verification successful'
              }); 
            } catch(e){
              console.warn('Failed to clear OTP error state on success:', e);
            }
          }
          return true; // Return success
        }
        
        // STEP 2: Check if we're still on OTP page (failure case)
        const stillOnOtpPage = await isOn2FAPage(driver);
        
        if (stillOnOtpPage) {
          // We're still on OTP page, check for specific OTP errors
          const otpErrorDetected = await isOtpVerificationFailed(driver);
          
          if (otpErrorDetected) {
            console.log('❌ OTP verification failed - incorrect code');
            if (REQUEST_ID) {
              try { 
                await postJson(`/api/internal/2fa-update/${REQUEST_ID}`, { 
                  errorType: 'INVALID_OTP',
                  method: 'OTP (SMS/Voice)',
                  message: 'Entered OTP was incorrect, please try again.',
                  showOtpModal: true,
                  otpError: 'The code you entered is not valid. Please check the code and try again.'
                }); 
              } catch(e){
                console.error('Error notifying server of INVALID_OTP:', e);
              }
            }
            throw new Error('INVALID_OTP');
          } else {
            // We're still on OTP page but no error shown - might be loading or in transition
            console.log('🔄 OTP submitted, waiting for page transition...');
            return false; // Let main flow handle redirection
          }
        } else {
          // We're not on OTP page and not on target page - we're probably in transition
          console.log('🔄 OTP submitted, page is transitioning...');
          return false; // Let main flow handle redirection
        }
      } else {
        console.warn('OTP filled but submit action failed.');
      }
    } else {
      console.warn('Could not locate OTP input to fill.');
    }
  } catch (err) {
    if (err.message === 'INVALID_OTP') {
      throw err; // Re-throw OTP errors
    }
    console.warn('Error in fillOtpAndSubmit:', err.message || err);
  }
  
  return false;
}

// Helper: post JSON to server internal endpoint
function postJson(pathname, data = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: '127.0.0.1',
      port: 5000,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(options, (res) => {
      let resp = '';
      res.on('data', (d) => resp += d.toString());
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: resp });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Helper: get JSON from server internal endpoint
function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 5000, path: pathname }, (res) => {
      let data = '';
      res.on('data', (d) => data += d.toString());
      res.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (e) {
          resolve({});
        }
      });
    }).on('error', reject);
  });
}

// read REQUEST_ID from env (set by server on spawn)
const REQUEST_ID = process.env.REQUEST_ID || null;

// Set Chrome options with Bluetooth and WebAuthn disabled
const options = new chrome.Options();
// options.addArguments('--headless=new');
options.addArguments('--no-sandbox');
options.addArguments('--disable-dev-shm-usage');
options.addArguments('--disable-gpu');

// Helper implementations
async function needsFullLogin(driver) {
  try {
    const emailSelectors = ['#ap_email', 'input[name="email"]', 'input[type="email"]', 'input#ap_email'];
    for (const sel of emailSelectors) {
      const els = await driver.findElements(By.css(sel));
      if (els.length > 0) return true;
    }
    const url = await driver.getCurrentUrl();
    if (url.includes('/ap/signin') || url.includes('/ap/login')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

async function isTrueReAuthScenario(driver) {
  try {
    const passSelectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]'];
    for (const sel of passSelectors) {
      const els = await driver.findElements(By.css(sel));
      if (els.length > 0) return true;
    }
    const url = await driver.getCurrentUrl();
    if (url.includes('/ap/re-auth') || url.includes('/ap/mfa/')) return true;
    const source = await driver.getPageSource();
    if (source && /re-auth|reauth|verify it's you|verify your identity/i.test(source)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// Enhanced authentication functions with error handling
async function performFullAuthentication(driver) {
  try {
    console.log('performFullAuthentication: starting (masked credentials)');
    
    // try to fill email
    try {
      const emailEls = await driver.findElements(By.css('#ap_email, input[name="email"], input[type="email"]'));
      if (emailEls.length > 0) {
        await emailEls[0].clear().catch(()=>{});
        await emailEls[0].sendKeys(AMAZON_EMAIL);
        // click continue if present
        const cont = await driver.findElements(By.css('input#continue, button#continue, input[name="continue"]'));
        if (cont.length > 0) { 
          try { 
            await cont[0].click(); 
            await sleep(2000);
          } catch(e){}
        }
      }
    } catch (e) { 
      console.warn('performFullAuthentication: email fill failed', e.message); 
    }

    // NEW: Check for invalid email error after submitting email
    await sleep(2000);
    const emailError = await checkForAuthErrors(driver);
    if (emailError === 'INVALID_EMAIL') {
      throw new Error('INVALID_EMAIL');
    }

    // fill password
    try {
      const passEls = await driver.findElements(By.css('#ap_password, input[name="password"], input[type="password"]'));
      if (passEls.length > 0) {
        await passEls[0].clear().catch(()=>{});
        await passEls[0].sendKeys(AMAZON_PASSWORD);
      }
      // click sign-in
      const signEls = await driver.findElements(By.css('input#signInSubmit, button#signInSubmit, button[name="signIn"], input[type="submit"]'));
      if (signEls.length > 0) {
        try { 
          await signEls[0].click(); 
        } catch (e) {}
      } else {
        await driver.actions().sendKeys('\n').perform();
      }
    } catch (e) {
      console.warn('performFullAuthentication: password/submit failed', e.message);
    }

    await sleep(3000);

    // NEW: Check for authentication errors after submitting password
    const authError = await checkForAuthErrors(driver);
    if (authError === 'INVALID_EMAIL') {
      throw new Error('INVALID_EMAIL');
    } else if (authError === 'INCORRECT_PASSWORD') {
      throw new Error('INCORRECT_PASSWORD');
    } else if (authError === 'UNKNOWN_2FA_PAGE') {
      throw new Error('UNKNOWN_2FA_PAGE');
    }

    // If 2FA page detected, notify server and handle accordingly
    if (await isOn2FAPage(driver)) {
      const method = await detect2FAMethod(driver);
      console.log('performFullAuthentication: 2FA detected ->', method);
      
      // NEW: Check if we're on unknown 2FA page
      if (await isUnknown2FAPage(driver)) {
        throw new Error('UNKNOWN_2FA_PAGE');
      }
      
      if (REQUEST_ID) {
        try { 
          await postJson(`/api/internal/2fa-update/${REQUEST_ID}`, { 
            method, 
            message: method.includes('Push') ? 
              'Please check your device and approve the push notification' : 
              'Please enter the verification code sent to your device',
            showOtpModal: method.includes('OTP')
          }); 
        } catch(e){}
      }

      if (method && /otp/i.test(method)) {
      // OTP flow - poll backend for OTP
      const start = Date.now();
      let otp = null;
      let attempts = 0;
      const maxOtpAttempts = 4;
      
      while (Date.now() - start < 5 * 60 * 1000 && attempts < maxOtpAttempts) {
        await sleep(2000);
        try {
          const resp = await getJson(`/api/internal/get-otp/${REQUEST_ID}`);
          if (resp && resp.otp) { 
            otp = resp.otp; 
            attempts++;
            console.log(`🔄 Attempting OTP verification (attempt ${attempts}/${maxOtpAttempts})`);
            
            try {
              const otpSuccess = await fillOtpAndSubmit(driver, otp);
              
              // CRITICAL FIX: Check for success immediately after submission
              if (otpSuccess || await isOnTargetPage(driver)) {
                console.log('✅ OTP authentication completed successfully');
                break; // Success - break out of OTP loop
              }
              
              // If we're here, OTP was submitted but we're waiting for redirect
              // Wait a bit more and check again
              await sleep(3000);
              
              // Check again if we reached target page
              if (await isOnTargetPage(driver)) {
                console.log('✅ OTP authentication completed successfully after wait');
                break; // Success - break out of OTP loop
              }
              
            } catch (otpErr) {
              if (otpErr.message === 'INVALID_OTP' && attempts < maxOtpAttempts) {
                console.log(`❌ OTP attempt ${attempts} failed, waiting for new OTP...`);
                // Clear the previous OTP from backend so we can get a new one
                if (REQUEST_ID) {
                  try { 
                    await postJson(`/api/internal/clear-otp/${REQUEST_ID}`); 
                  } catch(e){}
                }
                continue; // Try again with new OTP
              } else {
                throw otpErr; // Max attempts reached or other error
              }
            }
          }
          if (resp && resp.userConfirmed2FA) break;
        } catch (e) {}
      }
      
      if (attempts >= maxOtpAttempts) {
        throw new Error('Maximum OTP attempts exceeded');
      }
      
      // Only wait for redirect if we're not already on target page
      if (!await isOnTargetPage(driver)) {
        console.log('🔄 Waiting for final redirection after OTP...');
        const success = await waitForRedirectAfter2FA(driver);
        if (!success) {
          throw new Error('Failed to complete OTP redirection');
        }
      }
    } else {
        console.log('🔄 Waiting for push notification approval...');
        try {
          const success = await waitForRedirectAfter2FA(driver);
          if (!success) {
            throw new Error('Push notification approval failed or timed out');
          }
        } catch (error) {
          if (error.message === 'PUSH_NOTIFICATION_DENIED') {
            throw error; // Re-throw to be handled by main flow (which will cleanup browser)
          }
          throw new Error('Push notification approval failed or timed out');
        }
      }
    }

    // Final verification
    const onTarget = await isOnTargetPage(driver);
    if (!onTarget) {
      console.log('Current URL:', await driver.getCurrentUrl());
      throw new Error('Failed to reach target page after authentication');
    }
    
    return onTarget;
  } catch (err) {
    if (err.message === 'INVALID_EMAIL' || err.message === 'INCORRECT_PASSWORD' || 
        err.message === 'INVALID_OTP' || err.message === 'PUSH_NOTIFICATION_DENIED' ||
        err.message === 'UNKNOWN_2FA_PAGE') {
      throw err; // Re-throw authentication errors
    }
    console.warn('performFullAuthentication error:', err.message || err);
    return false;
  }
}

// Enhanced re-authentication with error handling
async function handleReAuth(driver) {
  try {
    console.log('handleReAuth: attempting re-auth (masked)');
    
    // try fill password
    try {
      const passEls = await driver.findElements(By.css('#ap_password, input[name="password"], input[type="password"]'));
      if (passEls.length > 0) {
        await passEls[0].clear().catch(()=>{});
        await passEls[0].sendKeys(AMAZON_PASSWORD);
      }
      const signEls = await driver.findElements(By.css('input#signInSubmit, button#signInSubmit, button[name="signIn"], input[type="submit"]'));
      if (signEls.length > 0) {
        try { 
          await signEls[0].click(); 
        } catch (e) {}
      } else {
        await driver.actions().sendKeys('\n').perform();
      }
    } catch (e) {
      console.warn('handleReAuth: password submit failed', e.message);
    }

    await sleep(2000);

    // NEW: Check for authentication errors after submitting password
    const authError = await checkForAuthErrors(driver);
    if (authError === 'INCORRECT_PASSWORD') {
      throw new Error('INCORRECT_PASSWORD');
    } else if (authError === 'UNKNOWN_2FA_PAGE') {
      throw new Error('UNKNOWN_2FA_PAGE');
    }

    // If 2FA appears after re-auth, handle same as full auth
    if (await isOn2FAPage(driver)) {
      const method = await detect2FAMethod(driver);
      console.log('handleReAuth: 2FA detected ->', method);
      
      // NEW: Check if we're on unknown 2FA page
      if (await isUnknown2FAPage(driver)) {
        throw new Error('UNKNOWN_2FA_PAGE');
      }
      
      if (REQUEST_ID) {
        try { 
          await postJson(`/api/internal/2fa-update/${REQUEST_ID}`, { 
            method, 
            message: method.includes('Push') ? 
              'Please check your device and approve the push notification' : 
              'Please enter the verification code sent to your device',
            showOtpModal: method.includes('OTP')
          }); 
        } catch(e){}
      }

      if (method && /otp/i.test(method)) {
      // OTP flow - poll backend for OTP
      const start = Date.now();
      let otp = null;
      let attempts = 0;
      const maxOtpAttempts = 3;
      
      while (Date.now() - start < 5 * 60 * 1000 && attempts < maxOtpAttempts) {
        await sleep(2000);
        try {
          const resp = await getJson(`/api/internal/get-otp/${REQUEST_ID}`);
          if (resp && resp.otp) { 
            otp = resp.otp; 
            attempts++;
            console.log(`🔄 Attempting OTP verification (attempt ${attempts}/${maxOtpAttempts})`);
            
            try {
              const otpSuccess = await fillOtpAndSubmit(driver, otp);
              
              // CRITICAL FIX: Check for success immediately after submission
              if (otpSuccess || await isOnTargetPage(driver)) {
                console.log('✅ OTP authentication completed successfully');
                break; // Success - break out of OTP loop
              }
              
              // If we're here, OTP was submitted but we're waiting for redirect
              // Wait a bit more and check again
              await sleep(3000);
              
              // Check again if we reached target page
              if (await isOnTargetPage(driver)) {
                console.log('✅ OTP authentication completed successfully after wait');
                break; // Success - break out of OTP loop
              }
              
            } catch (otpErr) {
              if (otpErr.message === 'INVALID_OTP' && attempts < maxOtpAttempts) {
                console.log(`❌ OTP attempt ${attempts} failed, waiting for new OTP...`);
                // Clear the previous OTP from backend so we can get a new one
                if (REQUEST_ID) {
                  try { 
                    await postJson(`/api/internal/clear-otp/${REQUEST_ID}`); 
                  } catch(e){}
                }
                continue; // Try again with new OTP
              } else {
                throw otpErr; // Max attempts reached or other error
              }
            }
          }
          if (resp && resp.userConfirmed2FA) break;
        } catch (e) {}
      }
      
      if (attempts >= maxOtpAttempts) {
        throw new Error('Maximum OTP attempts exceeded');
      }
      
      // Only wait for redirect if we're not already on target page
      if (!await isOnTargetPage(driver)) {
        console.log('🔄 Waiting for final redirection after OTP...');
        const success = await waitForRedirectAfter2FA(driver);
        if (!success) {
          throw new Error('Failed to complete OTP redirection');
        }
      }
    } else {
        // Push notification flow
        console.log('🔄 Waiting for push notification approval during re-auth...');
        try {
          const success = await waitForRedirectAfter2FA(driver);
          if (!success) {
            throw new Error('Push notification approval failed during re-auth');
          }
        } catch (error) {
          if (error.message === 'PUSH_NOTIFICATION_DENIED') {
            throw error; // Re-throw to be handled by main flow
          }
          throw new Error('Push notification approval failed during re-auth');
        }
      }
    }

    const onTarget = await isOnTargetPage(driver);
    if (!onTarget) {
      console.log('Current URL after re-auth:', await driver.getCurrentUrl());
    }
    
    return onTarget;
  } catch (err) {
    if (err.message === 'INCORRECT_PASSWORD' || err.message === 'INVALID_OTP' || err.message === 'PUSH_NOTIFICATION_DENIED' || err.message === 'UNKNOWN_2FA_PAGE') {
      throw err; // Re-throw authentication errors
    }
    console.warn('handleReAuth error:', err.message || err);
    return false;
  }
}

// NEW: Signal handlers for graceful shutdown
function setupSignalHandlers(driver) {
  const cleanup = async () => {
    console.log('\n🔄 Received shutdown signal, cleaning up browser...');
    if (driver) {
      try {
        await driver.quit();
        console.log('✅ Browser closed gracefully');
      } catch (error) {
        console.log('⚠️ Browser already closed');
      }
    }
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGUSR2', cleanup); // For nodemon
}

// OPTIMIZED MAIN EXECUTION FLOW with proper error handling and cleanup
(async function fetchAlexaActivity() {
  let driver;
  
  try {
    driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
    
    // Set up signal handlers for graceful shutdown
    setupSignalHandlers(driver);

    console.log('=== STARTING ALEXA ACTIVITY FETCH (HEADLESS) ===');
    
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
      const authResult = await performFullAuthentication(driver);
      if (!authResult) {
        // Check if we have specific authentication errors
        const authError = await checkForAuthErrors(driver);
        if (authError === 'INVALID_EMAIL') {
          console.log('❌ CRITICAL: Invalid email address provided');
          console.log(`   Please check your AMAZON_EMAIL environment variable: ${AMAZON_EMAIL}`);
          throw new Error('INVALID_EMAIL');
        } else if (authError === 'INCORRECT_PASSWORD') {
          console.log('❌ CRITICAL: Incorrect password provided');
          console.log('   Please check your AMAZON_PASSWORD environment variable');
          throw new Error('INCORRECT_PASSWORD');
        } else if (authError === 'UNKNOWN_2FA_PAGE') {
          console.log('❌ CRITICAL: Unknown 2FA page detected');
          console.log('   This account has been accessed too many times and requires additional verification');
          throw new Error('UNKNOWN_2FA_PAGE');
        }
        throw new Error('Authentication failed for unknown reasons');
      }
      needFinalNavigation = true;
    }
    // Only then check for true re-authentication
    else if (await isTrueReAuthScenario(driver)) {
      console.log('🔄 Re-authentication required...');
      const reAuthSuccess = await handleReAuth(driver);
      
      if (!reAuthSuccess || !await isOnTargetPage(driver)) {
        // Check for authentication errors
        const authError = await checkForAuthErrors(driver);
        if (authError === 'INCORRECT_PASSWORD') {
          console.log('❌ CRITICAL: Incorrect password provided during re-authentication');
          console.log('   Please check your AMAZON_PASSWORD environment variable');
          throw new Error('INCORRECT_PASSWORD');
        } else if (authError === 'UNKNOWN_2FA_PAGE') {
          console.log('❌ CRITICAL: Unknown 2FA page detected during re-authentication');
          console.log('   This account has been accessed too many times and requires additional verification');
          throw new Error('UNKNOWN_2FA_PAGE');
        }
        
        console.log('❌ Re-authentication failed, trying full authentication...');
        const fullAuthResult = await performFullAuthentication(driver);
        if (!fullAuthResult) {
          const authError = await checkForAuthErrors(driver);
          if (authError === 'INVALID_EMAIL') {
            console.log('❌ CRITICAL: Invalid email address provided');
            console.log(`   Please check your AMAZON_EMAIL environment variable: ${AMAZON_EMAIL}`);
            throw new Error('INVALID_EMAIL');
          } else if (authError === 'INCORRECT_PASSWORD') {
            console.log('❌ CRITICAL: Incorrect password provided');
            console.log('   Please check your AMAZON_PASSWORD environment variable');
            throw new Error('INCORRECT_PASSWORD');
          } else if (authError === 'UNKNOWN_2FA_PAGE') {
            console.log('❌ CRITICAL: Unknown 2FA page detected');
            console.log('   This account has been accessed too many times and requires additional verification');
            throw new Error('UNKNOWN_2FA_PAGE');
          }
          throw new Error('Full authentication also failed after re-auth failure');
        }
        needFinalNavigation = true;
      }
    }
    else {
      console.log('❓ Unknown state, assuming full authentication is needed...');
      const authResult = await performFullAuthentication(driver);
      if (!authResult) {
        const authError = await checkForAuthErrors(driver);
        if (authError === 'INVALID_EMAIL') {
          console.log('❌ CRITICAL: Invalid email address provided');
          console.log(`   Please check your AMAZON_EMAIL environment variable: ${AMAZON_EMAIL}`);
          throw new Error('INVALID_EMAIL');
        } else if (authError === 'INCORRECT_PASSWORD') {
          console.log('❌ CRITICAL: Incorrect password provided');
          console.log('   Please check your AMAZON_PASSWORD environment variable');
          throw new Error('INCORRECT_PASSWORD');
        } else if (authError === 'UNKNOWN_2FA_PAGE') {
          console.log('❌ CRITICAL: Unknown 2FA page detected');
          console.log('   This account has been accessed too many times and requires additional verification');
          throw new Error('UNKNOWN_2FA_PAGE');
        }
        throw new Error('Authentication failed for unknown reasons');
      }
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
      throw new Error('Failed to reach target page');
    }
  } catch (error) {
    console.error('💥 An error occurred:', error);
    
    // Handle specific authentication errors with user-friendly messages
    if (error.message === 'INVALID_EMAIL') {
      console.log('❌ CRITICAL: Invalid email address provided');
      console.log(`   Please check your AMAZON_EMAIL environment variable: ${AMAZON_EMAIL}`);
    } else if (error.message === 'INCORRECT_PASSWORD') {
      console.log('❌ CRITICAL: Incorrect password provided');
      console.log('   Please check your AMAZON_PASSWORD environment variable');
    } else if (error.message === 'INVALID_OTP') {
      console.log('❌ OTP verification failed');
    } else if (error.message === 'PUSH_NOTIFICATION_DENIED') {
      console.log('❌ Push notification was denied');
    } else if (error.message === 'UNKNOWN_2FA_PAGE') {
      console.log('❌ Unknown 2FA page detected');
      console.log('   This account has been accessed too many times and requires additional verification');
    } else {
      // For any other unexpected error, throw a generic user-friendly error
      console.log('❌ An unexpected error occurred during authentication');
    }
    
    // Don't re-throw to prevent unhandled promise rejection
    // The error is already logged and browser will be cleaned up in finally
  } finally {
    console.log('4. Cleaning up browser session...');
    if (driver) {
      try {
        await driver.quit();
        console.log('✅ Browser session closed successfully');
      } catch (quitError) {
        console.warn('⚠️ Error closing browser session:', quitError.message);
        // Force kill if normal quit fails
        try {
          await driver.close();
          console.log('✅ Browser closed with force method');
        } catch (closeError) {
          console.error('❌ Failed to close browser:', closeError.message);
        }
      }
    }
    console.log('=== HEADLESS SESSION COMPLETED ===');
  }
})();