import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.common.keys import Keys
import json
import os
import time
import base64
import hashlib
import sys
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Get credentials from environment variables
AMAZON_EMAIL = os.getenv('AMAZON_EMAIL')
AMAZON_PASSWORD = os.getenv('AMAZON_PASSWORD')

if not AMAZON_EMAIL or not AMAZON_PASSWORD:
    print('Error: Please set AMAZON_EMAIL and AMAZON_PASSWORD environment variables.')
    sys.exit(1)

# Generate a unique hash for current credentials
def generate_credentials_hash(email, password):
    return hashlib.sha256(f"{email}:{password}".encode()).hexdigest()[:16]

current_credentials_hash = generate_credentials_hash(AMAZON_EMAIL, AMAZON_PASSWORD)

# URLs for Amazon homepage and Alexa activity page
activity_url = 'https://www.amazon.in/alexa-privacy/apd/rvh'

def is_manual_mode():
    """Check if we're running in manual mode (no frontend pipeline)"""
    return 'REQUEST_ID' not in os.environ

def get_manual_otp():
    """Get manual OTP input from user"""
    print('\n🔢 Enter OTP code manually (or press Enter to skip and wait for auto-redirect): ', end='')
    otp = input().strip()
    return otp

def is_on_target_page(driver):
    """Check if we're on target page"""
    try:
        return '/alexa-privacy/apd/' in driver.current_url
    except:
        return False

def is_on_push_notification_page(driver):
    """Enhanced function to detect push notification page"""
    try:
        current_url = driver.current_url
        page_source = driver.page_source.lower()
        
        # Check for push notification page indicators
        push_indicators = [
            '/ap/cv/' in current_url,
            'transactionapprox' in current_url,
            'approve the notification' in page_source,
            'sent to:' in page_source,
            'amazonshopping' in page_source,
            'check your device' in page_source
        ]
        
        return any(push_indicators)
    except:
        return False

def detect_2fa_method(driver):
    """Enhanced 2FA method detection"""
    try:
        print('🔍 Detecting 2FA method...')
        
        current_url = driver.current_url
        
        # Check for OTP FIRST
        otp_selectors = [
            '#auth-mfa-otpcode',
            'input[name="otpCode"]',
            'input[name="code"]',
            'input[type="tel"]',
            'input[inputmode="numeric"]',
            'input[placeholder*="code"]',
            'input[placeholder*="otp"]'
        ]
        
        # Check OTP indicators first
        for selector in otp_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                if elements:
                    print('✅ Detected OTP 2FA method')
                    return 'OTP (SMS/Voice)'
            except:
                continue
        
        # Only AFTER checking OTP, check for push notification
        if is_on_push_notification_page(driver):
            print('✅ Detected Push Notification 2FA method')
            return 'Push Notification'
        
        return 'Unknown 2FA Method'
    except Exception as error:
        print(f'Error detecting 2FA method: {error}')
        return 'Error detecting 2FA method'

def is_on_2fa_page(driver):
    """Check if we're on any kind of 2FA page"""
    try:
        # Check for OTP input fields FIRST
        otp_input_selectors = [
            '#auth-mfa-otpcode',
            'input[name="otpCode"]',
            'input[name="code"]',
            'input[type="tel"]',
            'input[inputmode="numeric"]'
        ]
        
        for selector in otp_input_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                if elements:
                    return True
            except:
                continue
        
        # Only AFTER checking OTP, check for push notification page
        if is_on_push_notification_page(driver):
            return True
        
        current_url = driver.current_url
        
        # Check for 2FA text indicators
        otp_indicators = [
            'two-step verification',
            'two-factor authentication', 
            'verification code',
            'enter code'
        ]
        
        page_text = driver.page_source.lower()
        for indicator in otp_indicators:
            if indicator in page_text:
                return True
        
        return '/ap/' in current_url and (
            'mfa' in current_url or 
            'otp' in current_url or 
            'verify' in current_url
        )
        
    except:
        return False

def is_unknown_2fa_page(driver):
    """Detect unknown 2FA page (not OTP or Push)"""
    try:
        print('🔍 Checking for unknown 2FA page...')
        
        # If we're on target page, it's not unknown
        if is_on_target_page(driver):
            return False
        
        # If we're on known 2FA pages (OTP or Push), it's not unknown
        if is_on_2fa_page(driver):
            method = detect_2fa_method(driver)
            if method in ['OTP (SMS/Voice)', 'Push Notification']:
                return False
        
        # Check if we're on any Amazon authentication page that's not the target page
        current_url = driver.current_url
        if '/ap/' in current_url and '/alexa-privacy/apd/' not in current_url and not is_on_target_page(driver):
            print(f'🔴 Detected unknown 2FA/Auth page: {current_url}')
            return True
        
        return False
    except Exception as error:
        print(f'Error checking for unknown 2FA page: {error}')
        return False

def is_invalid_email_error(driver):
    """Detect invalid email error"""
    try:
        error_selectors = [
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'we cannot find an account with that email')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'no account found')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'invalid email')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'account not found')]",
            '.a-box-inner.a-alert-container',
            '.a-alert-content'
        ]
        
        for selector in error_selectors:
            try:
                if selector.startswith('//'):
                    elements = driver.find_elements(By.XPATH, selector)
                else:
                    elements = driver.find_elements(By.CSS_SELECTOR, selector)
                
                for element in elements:
                    text = element.text.lower()
                    if 'cannot find an account' in text or 'no account found' in text:
                        return True
            except:
                continue
        
        # Also check page source as fallback
        page_source = driver.page_source.lower()
        if 'cannot find an account' in page_source or 'no account found' in page_source:
            return True
        
        return False
    except:
        return False

def is_incorrect_password_error(driver):
    """Detect incorrect password error"""
    try:
        error_selectors = [
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'your password is incorrect')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'incorrect password')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'wrong password')]",
            '.a-box-inner.a-alert-container',
            '.a-alert-content',
            '.a-list-item'
        ]
        
        for selector in error_selectors:
            try:
                if selector.startswith('//'):
                    elements = driver.find_elements(By.XPATH, selector)
                else:
                    elements = driver.find_elements(By.CSS_SELECTOR, selector)
                
                for element in elements:
                    text = element.text.lower()
                    if 'password is incorrect' in text or 'incorrect password' in text:
                        return True
            except:
                continue
        
        # Also check page source as fallback
        page_source = driver.page_source.lower()
        if 'password is incorrect' in page_source or 'incorrect password' in page_source:
            return True
        
        return False
    except:
        return False

def check_for_auth_errors(driver, context='general'):
    """Check for authentication errors - IMPROVED"""
    print(f'🔍 Checking for authentication errors (context: {context})...')
    
    # Check for invalid email error
    if is_invalid_email_error(driver):
        print('❌ AUTHENTICATION ERROR: Invalid email address')
        print(f'   The email "{AMAZON_EMAIL}" is not associated with an Amazon account')
        return 'INVALID_EMAIL'
    
    # Check for incorrect password error
    if is_incorrect_password_error(driver):
        print('❌ AUTHENTICATION ERROR: Incorrect password')
        print('   The password provided does not match the email address')
        return 'INCORRECT_PASSWORD'
    
    # NEW: Check for unknown 2FA page
    if is_unknown_2fa_page(driver):
        print('❌ UNKNOWN 2FA PAGE: Unsupported authentication method detected')
        print('   This account requires additional verification that cannot be automated')
        return 'UNKNOWN_2FA_PAGE'
    
    return None

def needs_full_login(driver):
    """Check if we need full login"""
    try:
        email_selectors = ['#ap_email', 'input[name="email"]', 'input[type="email"]', 'input#ap_email']
        for selector in email_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                if elements:
                    return True
            except:
                continue
        
        url = driver.current_url
        if '/ap/signin' in url or '/ap/login' in url:
            return True
        
        return False
    except:
        return False

def is_true_re_auth_scenario(driver):
    """Check if this is a true re-authentication scenario"""
    try:
        pass_selectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]']
        for selector in pass_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                if elements:
                    return True
            except:
                continue
        
        url = driver.current_url
        if '/ap/re-auth' in url or '/ap/mfa/' in url:
            return True
        
        source = driver.page_source.lower()
        if source and any(phrase in source for phrase in ['re-auth', 'reauth', 'verify it\'s you', 'verify your identity']):
            return True
        
        return False
    except:
        return False

def fill_otp_and_submit(driver, otp):
    """Fill OTP and submit with REDIRECTION-BASED validation"""
    try:
        print(f'Attempting to auto-fill OTP (masked) ...')
        print(f'OTP (masked): {"*" * len(otp) if otp else ""}')

        otp_selectors = [
            '#auth-mfa-otpcode',
            'input[name="otpCode"]',
            'input[name="code"]',
            'input[placeholder*="code"]',
            'input[placeholder*="otp"]',
            'input[type="tel"]',
            'input[type="number"]',
            'input[inputmode="numeric"]'
        ]

        filled = False
        for selector in otp_selectors:
            try:
                element = driver.find_element(By.CSS_SELECTOR, selector)
                if element:
                    element.clear()
                    element.send_keys(otp)
                    filled = True
                    break
            except:
                continue

        if not filled:
            try:
                # Try XPath for text inputs with code/otp in placeholder
                xpath = "//input[@type='text' or @type='tel' or @type='number'][contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'code') or contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'otp')]"
                elements = driver.find_elements(By.XPATH, xpath)
                if elements:
                    elements[0].clear()
                    elements[0].send_keys(otp)
                    filled = True
            except:
                pass

        if filled:
            # Get current URL before submission to detect redirection
            url_before_submit = driver.current_url
            
            # Small pause to allow page to react to typed input
            time.sleep(0.4)

            submit_selectors = [
                '#cvf-submit-otp-button span input',
                'input.a-button-input[type="submit"]',
                'button[type="submit"]',
                'input[type="submit"]'
            ]

            clicked = False
            for selector in submit_selectors:
                try:
                    element = driver.find_element(By.CSS_SELECTOR, selector)
                    if element:
                        element.click()
                        clicked = True
                        break
                except:
                    continue

            if not clicked:
                try:
                    # Try to find any element and send Enter key
                    from selenium.webdriver.common.keys import Keys
                    element = driver.switch_to.active_element
                    element.send_keys(Keys.RETURN)
                    clicked = True
                except:
                    pass

            if clicked:
                print('OTP auto-submitted.')
                
                # Wait for page to process the OTP - allow time for redirection
                time.sleep(5)
                
                # NEW LOGIC: Check current URL and page state after submission
                current_url = driver.current_url
                still_on_otp_page = is_on_2fa_page(driver)
                on_target_page = is_on_target_page(driver)
                
                print(f'🔄 Post-submission state check:')
                print(f'   - Still on OTP page: {still_on_otp_page}')
                print(f'   - On target page: {on_target_page}')
                print(f'   - URL changed: {current_url != url_before_submit}')
                
                # SUCCESS CASE: We're on the target page
                if on_target_page:
                    print('✅ OTP verification SUCCESSFUL - redirected to target page')
                    return True
                
                # FAILURE CASE: We're still on an OTP page
                if still_on_otp_page:
                    print('❌ OTP verification FAILED - redirected back to OTP page')
                    
                    # Additional check: If we're on a DIFFERENT OTP page than before, it's definitely a failure
                    if current_url != url_before_submit and '/ap/' in current_url:
                        print('🔴 Confirmed OTP failure - redirected to different authentication page')
                    
                    raise Exception('INVALID_OTP')
                
                # TRANSITION CASE: We're not on OTP page and not on target page - might be in transition
                print('🔄 OTP submitted, page is transitioning...')
                return False
            
            else:
                print('OTP filled but submit action failed.')
        else:
            print('Could not locate OTP input to fill.')
            
    except Exception as err:
        if 'INVALID_OTP' in str(err):
            raise Exception('INVALID_OTP')
        print(f'Error in fill_otp_and_submit: {err}')
    
    return False

def handle_manual_otp_mode(driver):
    """Handle manual OTP mode"""
    if not is_manual_mode():
        return None
    
    print('\n🔧 MANUAL MODE: Running without frontend pipeline')
    print('📝 You can manually enter OTP or wait for auto-redirect')
    
    otp = get_manual_otp()
    
    if otp and len(otp) == 6 and otp.isdigit():
        print(f'🔄 Attempting to submit manual OTP: {"*" * len(otp)}')
        try:
            success = fill_otp_and_submit(driver, otp)
            if success:
                print('✅ Manual OTP submission successful!')
                return True
        except Exception as error:
            if 'INVALID_OTP' in str(error):
                print('❌ Manual OTP verification failed')
                print('🔄 Please try again or wait for auto-redirect')
                return False
            raise error
    elif otp:
        print('❌ Invalid OTP format. Please enter exactly 6 digits.')
        return False
    else:
        print('⏳ Skipping manual OTP, waiting for auto-redirect...')
        return None

def handle_otp_authentication(driver, context='full_auth'):
    """Enhanced OTP handling with manual mode support"""
    print(f'🔐 Handling OTP authentication ({context})...')
    
    attempts = 0
    max_otp_attempts = 10 if is_manual_mode() else 4  # More attempts in manual mode
    
    start_time = time.time()
    
    while time.time() - start_time < 10 * 60 and attempts < max_otp_attempts:  # 10 min timeout
        time.sleep(2)
        
        # NEW: Check for manual mode first
        if is_manual_mode():
            manual_result = handle_manual_otp_mode(driver)
            if manual_result is True:
                print('✅ Manual OTP authentication completed')
                break
            elif manual_result is False:
                attempts += 1
                continue  # Try again after failed manual attempt
            # If manual_result is None, user skipped manual input, continue with auto logic
        
        # In manual mode, check if we've been redirected automatically
        if is_manual_mode() and is_on_target_page(driver):
            print('✅ Automatic redirection detected! OTP no longer needed.')
            break
        
        # In manual mode, check if we're no longer on OTP page (user might have manually completed)
        if is_manual_mode() and not is_on_2fa_page(driver) and not is_on_target_page(driver):
            print('🔄 No longer on OTP page, checking authentication status...')
            # Wait a bit more to see if we get redirected
            time.sleep(5)
            if is_on_target_page(driver):
                print('✅ Manual authentication completed successfully!')
                break
    
    if attempts >= max_otp_attempts:
        raise Exception('Maximum OTP attempts exceeded')
    
    # Only wait for redirect if we're not already on target page
    if not is_on_target_page(driver):
        print('🔄 Waiting for final redirection after OTP...')
        success = wait_for_redirect_after_2fa(driver)
        if not success:
            raise Exception('Failed to complete OTP redirection')

def wait_for_redirect_after_2fa(driver, timeout=180):
    """Enhanced wait function with better push notification handling and cleanup"""
    print('⏳ Waiting for automatic redirection to activity page after 2FA...')
    
    start_time = time.time()
    last_state = '2fa_page'
    was_on_push_page = False
    
    try:
        while time.time() - start_time < timeout:
            try:
                current_url = driver.current_url
                
                # Check if we're on target page
                if is_on_target_page(driver):
                    print('✅ Automatic redirection detected! Now on target page.')
                    return True
                
                # Check if we're on push notification page
                on_push_page = is_on_push_notification_page(driver)
                if on_push_page:
                    was_on_push_page = True
                
                # Check if we're on any 2FA page
                on_2fa_page = is_on_2fa_page(driver)
                
                # Check if we're back on login page (error condition) - push notification failure
                on_login_page = needs_full_login(driver)
                
                # NEW: Detect push notification failure - THROW ERROR INSTEAD OF RETURNING
                if was_on_push_page and on_login_page and not on_2fa_page and not on_push_page:
                    print('❌ Push notification was denied or failed')
                    raise Exception('PUSH_NOTIFICATION_DENIED')
                
                if on_push_page:
                    if last_state != 'push_page':
                        print('📱 On push notification page - waiting for user to approve on device...')
                        last_state = 'push_page'
                    # Stay on push notification page and wait
                    time.sleep(5)
                    continue
                
                if on_2fa_page:
                    if last_state != '2fa_page':
                        print('🔐 Still on 2FA page, waiting...')
                        last_state = '2fa_page'
                    time.sleep(3)
                    continue
                
                # If we're not on 2FA page and not on target page, we might be in transition
                if not on_2fa_page and not on_push_page:
                    if last_state != 'transition':
                        print('🔄 2FA completed, waiting for final redirection...')
                        last_state = 'transition'
                    time.sleep(2)
                    continue
                
            except Exception as error:
                if 'PUSH_NOTIFICATION_DENIED' in str(error):
                    print('🔄 Propagating PUSH_NOTIFICATION_DENIED error to main flow...')
                    raise error  # Re-throw to break out of function entirely
                # If there's an error checking the page, wait and continue
                print('⚠️ Error checking page state, continuing to wait...')
                time.sleep(5)
        
        print('❌ Timeout waiting for automatic redirection after 2FA')
        return False
    except Exception as error:
        # Ensure any errors in this function are properly propagated
        if 'PUSH_NOTIFICATION_DENIED' in str(error):
            raise error  # Re-throw push denial errors
        print(f'Error in wait_for_redirect_after_2FA: {error}')
        raise error

def perform_full_authentication(driver):
    """Perform full authentication with manual mode support"""
    try:
        print('Starting full authentication process...')
        if is_manual_mode():
            print('🔧 MANUAL MODE: You may need to complete authentication steps in the browser')
        
        email_filled = False
        try:
            email_selectors = ['#ap_email', 'input[name="email"]', 'input[type="email"]']
            for selector in email_selectors:
                try:
                    element = driver.find_element(By.CSS_SELECTOR, selector)
                    if element:
                        element.clear()
                        element.send_keys(AMAZON_EMAIL)
                        email_filled = True
                        
                        continue_selectors = ['input#continue', 'button#continue', 'input[name="continue"]']
                        for cont_sel in continue_selectors:
                            try:
                                cont_element = driver.find_element(By.CSS_SELECTOR, cont_sel)
                                if cont_element:
                                    cont_element.click()
                                    time.sleep(2)
                                    break
                            except:
                                continue
                        break
                except:
                    continue
        except Exception as e:
            print(f'❌ Email fill failed: {e}')
        
        if not email_filled:
            print('⚠️ Could not find email field, checking if already on password page...')
        
        time.sleep(2)
        
        email_error = check_for_auth_errors(driver)
        if email_error == 'INVALID_EMAIL':
            raise Exception('INVALID_EMAIL')
        
        password_filled = False
        try:
            pass_selectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]']
            for selector in pass_selectors:
                try:
                    element = driver.find_element(By.CSS_SELECTOR, selector)
                    if element:
                        element.clear()
                        element.send_keys(AMAZON_PASSWORD)
                        password_filled = True
                        
                        sign_selectors = ['input#signInSubmit', 'button#signInSubmit', 'button[name="signIn"]', 'input[type="submit"]']
                        for sign_sel in sign_selectors:
                            try:
                                sign_element = driver.find_element(By.CSS_SELECTOR, sign_sel)
                                if sign_element:
                                    sign_element.click()
                                    break
                            except:
                                continue
                        break
                except:
                    continue
        except Exception as e:
            print(f'❌ Password fill failed: {e}')
        
        if not password_filled:
            print('⚠️ Could not find password field, checking current authentication state...')
        
        time.sleep(3)
        
        auth_error = check_for_auth_errors(driver)
        if auth_error == 'INVALID_EMAIL':
            raise Exception('INVALID_EMAIL')
        elif auth_error == 'INCORRECT_PASSWORD':
            raise Exception('INCORRECT_PASSWORD')
        elif auth_error == 'UNKNOWN_2FA_PAGE':
            raise Exception('UNKNOWN_2FA_PAGE')
        
        if is_on_2fa_page(driver):
            method = detect_2fa_method(driver)
            print(f'🔐 2FA detected -> {method}')
            
            if is_unknown_2fa_page(driver):
                raise Exception('UNKNOWN_2FA_PAGE')
            
            if method and 'otp' in method.lower():
                print('📱 OTP authentication required')
                handle_otp_authentication(driver, 'full_auth')
            else:
                print('📲 Push notification authentication required')
                try:
                    success = wait_for_redirect_after_2fa(driver)
                    if not success:
                        raise Exception('Push notification approval failed or timed out')
                except Exception as error:
                    if 'PUSH_NOTIFICATION_DENIED' in str(error):
                        raise error
                    raise Exception('Push notification approval failed or timed out')
        else:
            print('✅ No 2FA required, proceeding with standard authentication...')
        
        on_target = is_on_target_page(driver)
        if not on_target:
            print(f'❌ Not on target page. Current URL: {driver.current_url}')
            raise Exception('Failed to reach target page after authentication')
        
        print('✅ Authentication completed successfully')
        return on_target
        
    except Exception as err:
        if any(error in str(err) for error in ['INVALID_EMAIL', 'INCORRECT_PASSWORD', 'INVALID_OTP', 'PUSH_NOTIFICATION_DENIED', 'UNKNOWN_2FA_PAGE']):
            raise err
        print(f'❌ Authentication error: {err}')
        return False

def handle_re_auth(driver):
    """Enhanced re-authentication with manual mode support"""
    try:
        print('🔄 Starting re-authentication process...')
        if is_manual_mode():
            print('🔧 MANUAL MODE: You may need to complete re-authentication in the browser')
        
        # Try fill password
        print('🔑 Entering password for re-authentication...')
        password_filled = False
        try:
            pass_selectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]']
            for selector in pass_selectors:
                try:
                    element = driver.find_element(By.CSS_SELECTOR, selector)
                    if element:
                        element.clear()
                        element.send_keys(AMAZON_PASSWORD)
                        password_filled = True
                        print('✅ Password entered successfully')
                        
                        # Click sign-in
                        sign_selectors = ['input#signInSubmit', 'button#signInSubmit', 'button[name="signIn"]', 'input[type="submit"]']
                        for sign_sel in sign_selectors:
                            try:
                                sign_element = driver.find_element(By.CSS_SELECTOR, sign_sel)
                                if sign_element:
                                    sign_element.click()
                                    print('🔄 Submitted re-authentication credentials...')
                                    break
                            except:
                                continue
                        break
                except:
                    continue
        except Exception as e:
            print(f'❌ Password fill failed during re-auth: {e}')
        
        if not password_filled:
            print('⚠️ Could not find password field during re-auth')
        
        time.sleep(2)
        
        # NEW: Check for authentication errors after submitting password
        print('🔍 Checking for re-authentication errors...')
        auth_error = check_for_auth_errors(driver)
        if auth_error == 'INCORRECT_PASSWORD':
            raise Exception('INCORRECT_PASSWORD')
        elif auth_error == 'UNKNOWN_2FA_PAGE':
            raise Exception('UNKNOWN_2FA_PAGE')
        print('✅ Re-authentication validation passed')
        
        # If 2FA appears after re-auth, handle same as full auth
        if is_on_2fa_page(driver):
            method = detect_2fa_method(driver)
            print(f'🔐 2FA detected during re-auth -> {method}')
            
            # NEW: Check if we're on unknown 2FA page
            if is_unknown_2fa_page(driver):
                raise Exception('UNKNOWN_2FA_PAGE')
            
            if method and 'otp' in method.lower():
                print('📱 OTP authentication required for re-auth')
                # NEW: Use unified OTP handling function
                handle_otp_authentication(driver, 're_auth')
            else:
                # Push notification flow
                print('📲 Push notification authentication required for re-auth')
                print('🔄 Waiting for push notification approval during re-auth...')
                try:
                    success = wait_for_redirect_after_2fa(driver)
                    if not success:
                        raise Exception('Push notification approval failed during re-auth')
                except Exception as error:
                    if 'PUSH_NOTIFICATION_DENIED' in str(error):
                        raise error
                    raise Exception('Push notification approval failed during re-auth')
        
        print('🔍 Verifying re-authentication success...')
        on_target = is_on_target_page(driver)
        if not on_target:
            print(f'❌ Not on target page after re-auth. Current URL: {driver.current_url}')
        
        print('✅ Re-authentication completed successfully')
        return on_target
        
    except Exception as err:
        if any(error in str(err) for error in ['INCORRECT_PASSWORD', 'INVALID_OTP', 'PUSH_NOTIFICATION_DENIED', 'UNKNOWN_2FA_PAGE']):
            raise err
        print(f'❌ Re-authentication error: {err}')
        return False

def setup_signal_handlers(driver):
    """Signal handlers for graceful shutdown"""
    import signal
    
    def cleanup(signum, frame):
        print('\n🔄 Received shutdown signal, cleaning up browser...')
        if driver:
            try:
                driver.quit()
                print('✅ Browser closed gracefully')
            except:
                print('⚠️ Browser already closed')
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

def main():
    """OPTIMIZED MAIN EXECUTION FLOW with manual mode support"""
    driver = None
    
    try:
        # Launch undetected-chromedriver with optimized settings
        headless = os.getenv('HEADLESS', 'true').lower() == 'true'
        
        print('🔄 Launching undetected-chromedriver...')
        
        options = uc.ChromeOptions()
        
        # Add arguments for better performance and stealth
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--disable-gpu')
        options.add_argument('--disable-web-security')
        options.add_argument('--disable-background-timer-throttling')
        options.add_argument('--disable-backgrounding-occluded-windows')
        options.add_argument('--disable-renderer-backgrounding')
        options.add_argument('--disable-ipc-flooding-protection')
        options.add_argument('--no-default-browser-check')
        options.add_argument('--no-first-run')
        options.add_argument('--disable-default-apps')
        options.add_argument('--disable-translate')
        options.add_argument('--disable-extensions')
        options.add_argument('--window-size=1920,1080')
        
        # DISABLE PASSWORD SAVING AND PASSKEY PROMPTS
        options.add_argument('--disable-save-password-bubble')
        options.add_argument('--disable-autofill-keyboard-accessory-view')
        options.add_argument('--disable-features=PasswordSave,PasswordsAccountStorage,AutofillServerCommunication,AutofillShowTypePredictions')
        options.add_argument('--disable-single-click-autofill')
        options.add_argument('--disable-password-manager-reauthentication')
        options.add_argument('--disable-webauthn')
        options.add_argument('--disable-blink-features=WebAuthentication')
        
        # Add experimental options to disable password manager and autofill
        options.add_experimental_option('prefs', {
            'credentials_enable_service': False,
            'profile.password_manager_enabled': False,
            'profile.default_content_setting_values.notifications': 2,  # Block notifications
            'autofill.profile_enabled': False,
            'autofill.credit_card_enabled': False,
            'autofill.address_enabled': False,
            'password_manager_allow_show_passwords': False,
            'webauthn': {
                'enable_inline_cloud_access': False,
                'enable_hybrid': False
            }
        })
        
        if headless:
            options.add_argument('--headless')
        
        # Use version_main to specify the Chrome version
        driver = uc.Chrome(options=options, version_main=130)
        
        # Set up signal handlers for graceful shutdown
        setup_signal_handlers(driver)
        
        print('=== STARTING ALEXA ACTIVITY FETCH ===')
        if is_manual_mode():
            print('🔧 RUNNING IN MANUAL TEST MODE')
            print('   - You can manually enter OTP codes when prompted')
            print('   - Or complete authentication directly in the browser')
            print('   - The script will detect successful authentication automatically')
        else:
            print('🚀 RUNNING IN AUTOMATED PIPELINE MODE')
        
        # Step 1: Navigate directly to target page
        print('1. Navigating to Alexa activity page...')
        driver.get(activity_url)
        time.sleep(5)
        
        need_final_navigation = False
        
        # Step 2: OPTIMIZED - Check current state with better detection
        print('2. Checking authentication state...')
        
        if is_on_target_page(driver):
            print('✅ Already on target page!')
            # No authentication needed
        # OPTIMIZED: Check for full login FIRST (most common scenario for first run)
        elif needs_full_login(driver):
            print('🔐 Full authentication required...')
            auth_result = perform_full_authentication(driver)
            if not auth_result:
                # Check if we have specific authentication errors
                auth_error = check_for_auth_errors(driver)
                if auth_error == 'INVALID_EMAIL':
                    print('❌ CRITICAL: Invalid email address provided')
                    print(f'   Please check your AMAZON_EMAIL environment variable: {AMAZON_EMAIL}')
                    raise Exception('INVALID_EMAIL')
                elif auth_error == 'INCORRECT_PASSWORD':
                    print('❌ CRITICAL: Incorrect password provided')
                    print('   Please check your AMAZON_PASSWORD environment variable')
                    raise Exception('INCORRECT_PASSWORD')
                elif auth_error == 'UNKNOWN_2FA_PAGE':
                    print('❌ CRITICAL: Unknown 2FA page detected')
                    print('   This account has been accessed too many times and requires additional verification')
                    raise Exception('UNKNOWN_2FA_PAGE')
                raise Exception('Authentication failed for unknown reasons')
            need_final_navigation = True
        # Only then check for true re-authentication
        elif is_true_re_auth_scenario(driver):
            print('🔄 Re-authentication required...')
            re_auth_success = handle_re_auth(driver)
            
            if not re_auth_success or not is_on_target_page(driver):
                # Check for authentication errors
                auth_error = check_for_auth_errors(driver)
                if auth_error == 'INCORRECT_PASSWORD':
                    print('❌ CRITICAL: Incorrect password provided during re-authentication')
                    print('   Please check your AMAZON_PASSWORD environment variable')
                    raise Exception('INCORRECT_PASSWORD')
                elif auth_error == 'UNKNOWN_2FA_PAGE':
                    print('❌ CRITICAL: Unknown 2FA page detected during re-authentication')
                    print('   This account has been accessed too many times and requires additional verification')
                    raise Exception('UNKNOWN_2FA_PAGE')
                
                print('❌ Re-authentication failed, trying full authentication...')
                full_auth_result = perform_full_authentication(driver)
                if not full_auth_result:
                    auth_error = check_for_auth_errors(driver)
                    if auth_error == 'INVALID_EMAIL':
                        print('❌ CRITICAL: Invalid email address provided')
                        print(f'   Please check your AMAZON_EMAIL environment variable: {AMAZON_EMAIL}')
                        raise Exception('INVALID_EMAIL')
                    elif auth_error == 'INCORRECT_PASSWORD':
                        print('❌ CRITICAL: Incorrect password provided')
                        print('   Please check your AMAZON_PASSWORD environment variable')
                        raise Exception('INCORRECT_PASSWORD')
                    elif auth_error == 'UNKNOWN_2FA_PAGE':
                        print('❌ CRITICAL: Unknown 2FA page detected')
                        print('   This account has been accessed too many times and requires additional verification')
                        raise Exception('UNKNOWN_2FA_PAGE')
                    raise Exception('Full authentication also failed after re-auth failure')
                need_final_navigation = True
        else:
            print('❓ Unknown state, assuming full authentication is needed...')
            auth_result = perform_full_authentication(driver)
            if not auth_result:
                auth_error = check_for_auth_errors(driver)
                if auth_error == 'INVALID_EMAIL':
                    print('❌ CRITICAL: Invalid email address provided')
                    print(f'   Please check your AMAZON_EMAIL environment variable: {AMAZON_EMAIL}')
                    raise Exception('INVALID_EMAIL')
                elif auth_error == 'INCORRECT_PASSWORD':
                    print('❌ CRITICAL: Incorrect password provided')
                    print('   Please check your AMAZON_PASSWORD environment variable')
                    raise Exception('INCORRECT_PASSWORD')
                elif auth_error == 'UNKNOWN_2FA_PAGE':
                    print('❌ CRITICAL: Unknown 2FA page detected')
                    print('   This account has been accessed too many times and requires additional verification')
                    raise Exception('UNKNOWN_2FA_PAGE')
                raise Exception('Authentication failed for unknown reasons')
            need_final_navigation = True
        
        # Step 3: Only navigate if we're not already on the target page
        if need_final_navigation and not is_on_target_page(driver):
            print('3. Navigating to target page...')
            driver.get(activity_url)
            time.sleep(5)
        else:
            print('3. Already on target page, skipping navigation.')
        
        # Final verification
        if is_on_target_page(driver):
            print('✅ Successfully reached Alexa activity page!')
            
            # Save cookies
            cookies = driver.get_cookies()
            output_cookies_path = os.path.join('backend', 'cookies.json')
            os.makedirs(os.path.dirname(output_cookies_path), exist_ok=True)
            
            with open(output_cookies_path, 'w') as f:
                json.dump(cookies, f, indent=2)
            
            print(f'💾 Cookies have been written to {output_cookies_path}')
        else:
            print('❌ Failed to reach Alexa activity page')
            current_url = driver.current_url
            print(f'Final URL: {current_url}')
            raise Exception('Failed to reach target page')
            
    except Exception as error:
        print(f'💥 An error occurred: {error}')
        
        # Handle specific authentication errors with user-friendly messages
        if 'INVALID_EMAIL' in str(error):
            print('❌ CRITICAL: Invalid email address provided')
            print(f'   Please check your AMAZON_EMAIL environment variable: {AMAZON_EMAIL}')
        elif 'INCORRECT_PASSWORD' in str(error):
            print('❌ CRITICAL: Incorrect password provided')
            print('   Please check your AMAZON_PASSWORD environment variable')
        elif 'INVALID_OTP' in str(error):
            print('❌ OTP verification failed')
        elif 'PUSH_NOTIFICATION_DENIED' in str(error):
            print('❌ Push notification was denied')
        elif 'UNKNOWN_2FA_PAGE' in str(error):
            print('❌ Unknown 2FA page detected')
            print('   This account has been accessed too many times and requires additional verification')
        else:
            # For any other unexpected error, throw a generic user-friendly error
            print('❌ An unexpected error occurred during authentication')
        
    finally:
        print('4. Cleaning up browser session...')
        if driver:
            try:
                driver.quit()
                print('✅ Browser session closed successfully')
            except Exception as quit_error:
                print(f'⚠️ Error closing browser session: {quit_error}')
        print('=== SESSION COMPLETED ===')

if __name__ == '__main__':
    main()