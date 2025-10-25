const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const readline = require('readline');
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

// NEW: Check if we're running in manual mode (no frontend pipeline)
const isManualMode = !process.env.REQUEST_ID;

// NEW: Function to get manual OTP input from user
function getManualOtp() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('🔢 Enter OTP code manually (or press Enter to skip and wait for auto-redirect): ', (otp) => {
      rl.close();
      resolve(otp.trim());
    });
  });
}

// NEW: Function to handle manual OTP mode
async function handleManualOtpMode(page) {
  if (!isManualMode) return null;
  
  console.log('\n🔧 MANUAL MODE: Running without frontend pipeline');
  console.log('📝 You can manually enter OTP or wait for auto-redirect');
  
  const otp = await getManualOtp();
  
  if (otp && otp.length === 6 && /^\d{6}$/.test(otp)) {
    console.log(`🔄 Attempting to submit manual OTP: ${otp.replace(/\d/g, '*')}`);
    try {
      const success = await fillOtpAndSubmit(page, otp);
      if (success) {
        console.log('✅ Manual OTP submission successful!');
        return true;
      }
    } catch (error) {
      if (error.message === 'INVALID_OTP') {
        console.log('❌ Manual OTP verification failed');
        console.log('🔄 Please try again or wait for auto-redirect');
        return false;
      }
      throw error;
    }
  } else if (otp) {
    console.log('❌ Invalid OTP format. Please enter exactly 6 digits.');
    return false;
  } else {
    console.log('⏳ Skipping manual OTP, waiting for auto-redirect...');
    return null;
  }
}

// NEW: Enhanced OTP handling with manual mode support
async function handleOtpAuthentication(page, context = 'full_auth') {
  console.log(`🔐 Handling OTP authentication (${context})...`);
  
  let attempts = 0;
  const maxOtpAttempts = isManualMode ? 10 : 4; // More attempts in manual mode
  
  const start = Date.now();
  
  while (Date.now() - start < 10 * 60 * 1000 && attempts < maxOtpAttempts) { // 10 min timeout
    await sleep(2000);
    
    // NEW: Check for manual mode first
    if (isManualMode) {
      const manualResult = await handleManualOtpMode(page);
      if (manualResult === true) {
        console.log('✅ Manual OTP authentication completed');
        break;
      } else if (manualResult === false) {
        attempts++;
        continue; // Try again after failed manual attempt
      }
      // If manualResult is null, user skipped manual input, continue with auto logic
    }
    
    // Original automated OTP logic for pipeline mode
    if (!isManualMode) {
      try {
        const resp = await getJson(`/api/internal/get-otp/${REQUEST_ID}`);
        if (resp && resp.otp) { 
          const otp = resp.otp;
          attempts++;
          console.log(`🔄 Attempting OTP verification (attempt ${attempts}/${maxOtpAttempts})`);
          
          try {
            const otpSuccess = await fillOtpAndSubmit(page, otp);
            
            if (otpSuccess || await isOnTargetPage(page)) {
              console.log('✅ OTP authentication completed successfully');
              break;
            }
            
            await sleep(3000);
            
            if (await isOnTargetPage(page)) {
              console.log('✅ OTP authentication completed successfully after wait');
              break;
            }
            
          } catch (otpErr) {
            if (otpErr.message === 'INVALID_OTP' && attempts < maxOtpAttempts) {
              console.log(`❌ OTP attempt ${attempts} failed, waiting for new OTP...`);
              if (REQUEST_ID) {
                try { 
                  await postJson(`/api/internal/clear-otp/${REQUEST_ID}`); 
                } catch(e){}
              }
              continue;
            } else {
              throw otpErr;
            }
          }
        }
        if (resp && resp.userConfirmed2FA) break;
      } catch (e) {
        // Continue polling in case of network errors
      }
    }
    
    // NEW: In manual mode, check if we've been redirected automatically
    if (isManualMode && await isOnTargetPage(page)) {
      console.log('✅ Automatic redirection detected! OTP no longer needed.');
      break;
    }
    
    // NEW: In manual mode, check if we're no longer on OTP page (user might have manually completed)
    if (isManualMode && !await isOn2FAPage(page) && !await isOnTargetPage(page)) {
      console.log('🔄 No longer on OTP page, checking authentication status...');
      // Wait a bit more to see if we get redirected
      await sleep(5000);
      if (await isOnTargetPage(page)) {
        console.log('✅ Manual authentication completed successfully!');
        break;
      }
    }
  }
  
  if (attempts >= maxOtpAttempts) {
    throw new Error('Maximum OTP attempts exceeded');
  }
  
  // Only wait for redirect if we're not already on target page
  if (!await isOnTargetPage(page)) {
    console.log('🔄 Waiting for final redirection after OTP...');
    const success = await waitForRedirectAfter2FA(page);
    if (!success) {
      throw new Error('Failed to complete OTP redirection');
    }
  }
}

// NEW: Function to detect unknown 2FA page (not OTP or Push)
async function isUnknown2FAPage(page) {
  try {
    console.log('🔍 Checking for unknown 2FA page...');
    
    // If we're on target page, it's not unknown
    if (await isOnTargetPage(page)) {
      return false;
    }
    
    // If we're on known 2FA pages (OTP or Push), it's not unknown
    if (await isOn2FAPage(page)) {
      const method = await detect2FAMethod(page);
      if (method === 'OTP (SMS/Voice)' || method === 'Push Notification') {
        return false;
      }
    }
    
    // Check if we're on any Amazon authentication page that's not the target page
    const currentUrl = page.url();
    if (currentUrl.includes('/ap/') && 
        !currentUrl.includes('/alexa-privacy/apd/') &&
        !await isOnTargetPage(page)) {
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
async function isInvalidEmailError(page) {
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
          const elements = await page.$x(selector);
          for (const element of elements) {
            const text = await page.evaluate(el => el.textContent, element);
            if (text && text.toLowerCase().includes('cannot find an account') || 
                text.toLowerCase().includes('no account found')) {
              return true;
            }
          }
        } else {
          const elements = await page.$$(selector);
          for (const element of elements) {
            const text = await page.evaluate(el => el.textContent, element);
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
    const pageSource = await page.content();
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
async function isIncorrectPasswordError(page) {
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
          const elements = await page.$x(selector);
          for (const element of elements) {
            const text = await page.evaluate(el => el.textContent, element);
            if (text && (text.toLowerCase().includes('password is incorrect') || 
                text.toLowerCase().includes('incorrect password'))) {
              return true;
            }
          }
        } else {
          const elements = await page.$$(selector);
          for (const element of elements) {
            const text = await page.evaluate(el => el.textContent, element);
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
    const pageSource = await page.content();
    if (pageSource.toLowerCase().includes('password is incorrect') || 
        pageSource.toLowerCase().includes('incorrect password')) {
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// NEW: Function to detect and handle authentication errors - IMPROVED
async function checkForAuthErrors(page, context = 'general') {
  console.log(`🔍 Checking for authentication errors (context: ${context})...`);
  
  // Check for invalid email error
  if (await isInvalidEmailError(page)) {
    console.log('❌ AUTHENTICATION ERROR: Invalid email address');
    console.log(`   The email "${AMAZON_EMAIL}" is not associated with an Amazon account`);
    return 'INVALID_EMAIL';
  }
  
  // Check for incorrect password error
  if (await isIncorrectPasswordError(page)) {
    console.log('❌ AUTHENTICATION ERROR: Incorrect password');
    console.log('   The password provided does not match the email address');
    return 'INCORRECT_PASSWORD';
  }
  
  // NEW: Check for unknown 2FA page
  if (await isUnknown2FAPage(page)) {
    console.log('❌ UNKNOWN 2FA PAGE: Unsupported authentication method detected');
    console.log('   This account requires additional verification that cannot be automated');
    return 'UNKNOWN_2FA_PAGE';
  }
  
  return null;
}

// Check if we're on target page
async function isOnTargetPage(page) {
  try {
    const currentUrl = page.url();
    return currentUrl.includes('/alexa-privacy/apd/');
  } catch (error) {
    return false;
  }
}

// Enhanced function to detect push notification page
async function isOnPushNotificationPage(page) {
  try {
    const currentUrl = page.url();
    const pageSource = await page.content();
    
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
          const elements = await page.$x(indicator);
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
async function detect2FAMethod(page) {
  try {
    console.log('🔍 Detecting 2FA method...');
    
    const currentUrl = page.url();
    const pageSource = await page.content();
    
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
          const elements = await page.$x(indicator);
          if (elements.length > 0) {
            console.log('✅ Detected OTP 2FA method');
            return 'OTP (SMS/Voice)';
          }
        } else {
          const elements = await page.$$(indicator);
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
    if (await isOnPushNotificationPage(page)) {
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
async function isOn2FAPage(page) {
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
      const elements = await page.$$(sel);
      if (elements.length > 0) {
        return true;
      }
    }
    
    // Only AFTER checking OTP, check for push notification page
    if (await isOnPushNotificationPage(page)) {
      return true;
    }
    
    const currentUrl = page.url();
    
    // Check for 2FA text indicators
    const otpIndicators = [
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'two-step verification')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'two-factor authentication')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'verification code')]",
      "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'enter code')]"
    ];
    
    for (const xpath of otpIndicators) {
      try {
        const elements = await page.$x(xpath);
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
async function waitForRedirectAfter2FA(page, timeout = 180000) {
  console.log('⏳ Waiting for automatic redirection to activity page after 2FA...');
  
  const startTime = Date.now();
  let lastState = '2fa_page';
  let wasOnPushPage = false;
  
  try {
    while (Date.now() - startTime < timeout) {
      try {
        const currentUrl = page.url();
        
        // Check if we're on target page
        if (await isOnTargetPage(page)) {
          console.log('✅ Automatic redirection detected! Now on target page.');
          return true;
        }
        
        // Check if we're on push notification page
        const onPushPage = await isOnPushNotificationPage(page);
        if (onPushPage) {
          wasOnPushPage = true;
        }
        
        // Check if we're on any 2FA page
        const on2FAPage = await isOn2FAPage(page);
        
        // Check if we're back on login page (error condition) - push notification failure
        const onLoginPage = await needsFullLogin(page);
        
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

// NEW IMPROVED: Handle OTP submission and verification with REDIRECTION-BASED validation
async function fillOtpAndSubmit(page, otp) {
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
    for (const sel of otpSelectors) {
      try {
        const element = await page.$(sel);
        if (element) {
          await element.click({ clickCount: 3 }); // Select all text
          await element.type(otp);
          filled = true;
          break;
        }
      } catch (e) { /* ignore and continue */ }
    }

    if (!filled) {
      try {
        const elements = await page.$$x("//input[@type='text' or @type='tel' or @type='number'][contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'code') or contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'otp')]");
        if (elements.length > 0) {
          await elements[0].click({ clickCount: 3 });
          await elements[0].type(otp);
          filled = true;
        }
      } catch (e) {}
    }

    if (filled) {
      // Get current URL before submission to detect redirection
      const urlBeforeSubmit = page.url();
      
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
          const element = await page.$(sel);
          if (element) {
            await element.click();
            clicked = true;
            break;
          }
        } catch (e) { /* ignore and try next */ }
      }

      if (!clicked) {
        try {
          await page.keyboard.press('Enter');
          clicked = true;
        } catch (e) {}
      }

      if (clicked) {
        console.log('OTP auto-submitted.');
        
        // Wait for page to process the OTP - allow time for redirection
        await sleep(5000);
        
        // NEW LOGIC: Check current URL and page state after submission
        const currentUrl = page.url();
        const stillOnOtpPage = await isOn2FAPage(page);
        const onTargetPage = await isOnTargetPage(page);
        
        console.log(`🔄 Post-submission state check:`);
        console.log(`   - Still on OTP page: ${stillOnOtpPage}`);
        console.log(`   - On target page: ${onTargetPage}`);
        console.log(`   - URL changed: ${currentUrl !== urlBeforeSubmit}`);
        
        // SUCCESS CASE: We're on the target page
        if (onTargetPage) {
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
        
        // FAILURE CASE: We're still on an OTP page (redirection back to OTP page indicates invalid OTP)
        if (stillOnOtpPage) {
          console.log('❌ OTP verification FAILED - redirected back to OTP page');
          
          // Additional check: If we're on a DIFFERENT OTP page than before, it's definitely a failure
          if (currentUrl !== urlBeforeSubmit && currentUrl.includes('/ap/')) {
            console.log('🔴 Confirmed OTP failure - redirected to different authentication page');
          }
          
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
        }
        
        // TRANSITION CASE: We're not on OTP page and not on target page - might be in transition
        console.log('🔄 OTP submitted, page is transitioning...');
        return false; // Let main flow handle redirection
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

// Helper implementations
async function needsFullLogin(page) {
  try {
    const emailSelectors = ['#ap_email', 'input[name="email"]', 'input[type="email"]', 'input#ap_email'];
    for (const sel of emailSelectors) {
      const elements = await page.$$(sel);
      if (elements.length > 0) return true;
    }
    const url = page.url();
    if (url.includes('/ap/signin') || url.includes('/ap/login')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

async function isTrueReAuthScenario(page) {
  try {
    const passSelectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]'];
    for (const sel of passSelectors) {
      const elements = await page.$$(sel);
      if (elements.length > 0) return true;
    }
    const url = page.url();
    if (url.includes('/ap/re-auth') || url.includes('/ap/mfa/')) return true;
    const source = await page.content();
    if (source && /re-auth|reauth|verify it's you|verify your identity/i.test(source)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// Enhanced authentication functions with manual mode support
async function performFullAuthentication(page) {
  try {
    console.log('performFullAuthentication: starting (masked credentials)');
    if (isManualMode) {
      console.log('🔧 MANUAL MODE: You may need to complete authentication steps in the browser');
    }
    
    // try to fill email
    try {
      const emailSelectors = ['#ap_email', 'input[name="email"]', 'input[type="email"]'];
      for (const sel of emailSelectors) {
        const element = await page.$(sel);
        if (element) {
          await element.click({ clickCount: 3 });
          await element.type(AMAZON_EMAIL);
          
          // click continue if present
          const continueSelectors = ['input#continue', 'button#continue', 'input[name="continue"]'];
          for (const contSel of continueSelectors) {
            const contElement = await page.$(contSel);
            if (contElement) {
              await contElement.click();
              await sleep(2000);
              break;
            }
          }
          break;
        }
      }
    } catch (e) { 
      console.warn('performFullAuthentication: email fill failed', e.message); 
    }

    // NEW: Check for invalid email error after submitting email
    await sleep(2000);
    const emailError = await checkForAuthErrors(page);
    if (emailError === 'INVALID_EMAIL') {
      throw new Error('INVALID_EMAIL');
    }

    // fill password
    try {
      const passSelectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]'];
      for (const sel of passSelectors) {
        const element = await page.$(sel);
        if (element) {
          await element.click({ clickCount: 3 });
          await element.type(AMAZON_PASSWORD);
          
          // click sign-in
          const signSelectors = ['input#signInSubmit', 'button#signInSubmit', 'button[name="signIn"]', 'input[type="submit"]'];
          for (const signSel of signSelectors) {
            const signElement = await page.$(signSel);
            if (signElement) {
              await signElement.click();
              break;
            }
          }
          break;
        }
      }
    } catch (e) {
      console.warn('performFullAuthentication: password/submit failed', e.message);
    }

    await sleep(3000);

    // NEW: Check for authentication errors after submitting password
    const authError = await checkForAuthErrors(page);
    if (authError === 'INVALID_EMAIL') {
      throw new Error('INVALID_EMAIL');
    } else if (authError === 'INCORRECT_PASSWORD') {
      throw new Error('INCORRECT_PASSWORD');
    } else if (authError === 'UNKNOWN_2FA_PAGE') {
      throw new Error('UNKNOWN_2FA_PAGE');
    }

    // If 2FA page detected, notify server and handle accordingly
    if (await isOn2FAPage(page)) {
      const method = await detect2FAMethod(page);
      console.log('performFullAuthentication: 2FA detected ->', method);
      
      // NEW: Check if we're on unknown 2FA page
      if (await isUnknown2FAPage(page)) {
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
        // NEW: Use unified OTP handling function
        await handleOtpAuthentication(page, 'full_auth');
      } else {
        console.log('🔄 Waiting for push notification approval...');
        try {
          const success = await waitForRedirectAfter2FA(page);
          if (!success) {
            throw new Error('Push notification approval failed or timed out');
          }
        } catch (error) {
          if (error.message === 'PUSH_NOTIFICATION_DENIED') {
            throw error;
          }
          throw new Error('Push notification approval failed or timed out');
        }
      }
    }

    // Final verification
    const onTarget = await isOnTargetPage(page);
    if (!onTarget) {
      console.log('Current URL:', page.url());
      throw new Error('Failed to reach target page after authentication');
    }
    
    return onTarget;
  } catch (err) {
    if (err.message === 'INVALID_EMAIL' || err.message === 'INCORRECT_PASSWORD' || 
        err.message === 'INVALID_OTP' || err.message === 'PUSH_NOTIFICATION_DENIED' ||
        err.message === 'UNKNOWN_2FA_PAGE') {
      throw err;
    }
    console.warn('performFullAuthentication error:', err.message || err);
    return false;
  }
}

// Enhanced re-authentication with manual mode support
async function handleReAuth(page) {
  try {
    console.log('handleReAuth: attempting re-auth (masked)');
    if (isManualMode) {
      console.log('🔧 MANUAL MODE: You may need to complete re-authentication in the browser');
    }

    // try fill password
    try {
      const passSelectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]'];
      for (const sel of passSelectors) {
        const element = await page.$(sel);
        if (element) {
          await element.click({ clickCount: 3 });
          await element.type(AMAZON_PASSWORD);
          
          // click sign-in
          const signSelectors = ['input#signInSubmit', 'button#signInSubmit', 'button[name="signIn"]', 'input[type="submit"]'];
          for (const signSel of signSelectors) {
            const signElement = await page.$(signSel);
            if (signElement) {
              await signElement.click();
              break;
            }
          }
          break;
        }
      }
    } catch (e) {
      console.warn('handleReAuth: password/submit failed', e.message);
    }

    await sleep(2000);

    // NEW: Check for authentication errors after submitting password
    const authError = await checkForAuthErrors(page);
    if (authError === 'INCORRECT_PASSWORD') {
      throw new Error('INCORRECT_PASSWORD');
    } else if (authError === 'UNKNOWN_2FA_PAGE') {
      throw new Error('UNKNOWN_2FA_PAGE');
    }

    // If 2FA appears after re-auth, handle same as full auth
    if (await isOn2FAPage(page)) {
      const method = await detect2FAMethod(page);
      console.log('handleReAuth: 2FA detected ->', method);
      
      // NEW: Check if we're on unknown 2FA page
      if (await isUnknown2FAPage(page)) {
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
        // NEW: Use unified OTP handling function
        await handleOtpAuthentication(page, 're_auth');
      } else {
        // Push notification flow
        console.log('🔄 Waiting for push notification approval during re-auth...');
        try {
          const success = await waitForRedirectAfter2FA(page);
          if (!success) {
            throw new Error('Push notification approval failed during re-auth');
          }
        } catch (error) {
          if (error.message === 'PUSH_NOTIFICATION_DENIED') {
            throw error;
          }
          throw new Error('Push notification approval failed during re-auth');
        }
      }
    }

    const onTarget = await isOnTargetPage(page);
    if (!onTarget) {
      console.log('Current URL after re-auth:', page.url());
    }
    
    return onTarget;
  } catch (err) {
    if (err.message === 'INCORRECT_PASSWORD' || err.message === 'INVALID_OTP' || err.message === 'PUSH_NOTIFICATION_DENIED' || err.message === 'UNKNOWN_2FA_PAGE') {
      throw err;
    }
    console.warn('handleReAuth error:', err.message || err);
    return false;
  }
}

// NEW: Signal handlers for graceful shutdown
function setupSignalHandlers(browser) {
  const cleanup = async () => {
    console.log('\n🔄 Received shutdown signal, cleaning up browser...');
    if (browser) {
      try {
        await browser.close();
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

// OPTIMIZED MAIN EXECUTION FLOW with manual mode support
(async function fetchAlexaActivity() {
  let browser;
  let page;
  
  try {
    // Launch Puppeteer with optimized settings for server environments

    const headless = process.env.HEADLESS
      ? process.env.HEADLESS.toLowerCase() === 'true'
      : true;

    console.log('🔄 Launching Puppeteer...');
    browser = await puppeteer.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-translate',
        '--disable-extensions',
        '--window-size=1920,1080'
      ],
      defaultViewport: { width: 1920, height: 1080 }
    });
    
    page = await browser.newPage();
    
    // Set up signal handlers for graceful shutdown
    setupSignalHandlers(browser);

    // Set user agent to mimic real browser
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('=== STARTING ALEXA ACTIVITY FETCH ===');
    if (isManualMode) {
      console.log('🔧 RUNNING IN MANUAL TEST MODE');
      console.log('   - You can manually enter OTP codes when prompted');
      console.log('   - Or complete authentication directly in the browser');
      console.log('   - The script will detect successful authentication automatically');
    } else {
      console.log('🚀 RUNNING IN AUTOMATED PIPELINE MODE');
    }
    
    // Step 1: Navigate directly to target page
    console.log('1. Navigating to Alexa activity page...');
    await page.goto(activityUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(5000);
    
    let needFinalNavigation = false;
    
    // Step 2: OPTIMIZED - Check current state with better detection
    console.log('2. Checking authentication state...');
    
    if (await isOnTargetPage(page)) {
      console.log('✅ Already on target page!');
      // No authentication needed
    } 
    // OPTIMIZED: Check for full login FIRST (most common scenario for first run)
    else if (await needsFullLogin(page)) {
      console.log('🔐 Full authentication required...');
      const authResult = await performFullAuthentication(page);
      if (!authResult) {
        // Check if we have specific authentication errors
        const authError = await checkForAuthErrors(page);
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
    else if (await isTrueReAuthScenario(page)) {
      console.log('🔄 Re-authentication required...');
      const reAuthSuccess = await handleReAuth(page);
      
      if (!reAuthSuccess || !await isOnTargetPage(page)) {
        // Check for authentication errors
        const authError = await checkForAuthErrors(page);
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
        const fullAuthResult = await performFullAuthentication(page);
        if (!fullAuthResult) {
          const authError = await checkForAuthErrors(page);
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
      const authResult = await performFullAuthentication(page);
      if (!authResult) {
        const authError = await checkForAuthErrors(page);
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
    if (needFinalNavigation && !await isOnTargetPage(page)) {
      console.log('3. Navigating to target page...');
      await page.goto(activityUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(5000);
    } else {
      console.log('3. Already on target page, skipping navigation.');
    }
    
    // Final verification
    if (await isOnTargetPage(page)) {
      console.log('✅ Successfully reached Alexa activity page!');
      
      // Save cookies
      const cookies = await page.cookies();
      const outputCookiesPath = path.join(__dirname, 'cookies.json');
      fs.writeFileSync(outputCookiesPath, JSON.stringify(cookies, null, 2));
      console.log(`💾 Cookies have been written to ${outputCookiesPath}`);
    } else {
      console.log('❌ Failed to reach Alexa activity page');
      const currentUrl = page.url();
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
    if (browser) {
      try {
        await browser.close();
        console.log('✅ Browser session closed successfully');
      } catch (quitError) {
        console.warn('⚠️ Error closing browser session:', quitError.message);
      }
    }
    console.log('=== SESSION COMPLETED ===');
  }
})();