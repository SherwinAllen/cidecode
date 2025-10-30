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
import requests

# Load environment variables
load_dotenv()

# Get credentials from environment variables
AMAZON_EMAIL = os.getenv('AMAZON_EMAIL')
AMAZON_PASSWORD = os.getenv('AMAZON_PASSWORD')

if not AMAZON_EMAIL or not AMAZON_PASSWORD:
    print('Error: Please set AMAZON_EMAIL and AMAZON_PASSWORD environment variables.')
    sys.exit(1)

def update_server_status(method=None, message=None, current_url=None, error_type=None, otp_error=None, show_otp_modal=None):
    """Send real-time status updates to the Node.js server"""
    request_id = os.environ.get('REQUEST_ID')
    if not request_id:
        if message:
            print(f"INFO: {message}")
        return
    
    try:
        payload = {}
        if method is not None:
            payload['method'] = method
        if message is not None:
            payload['message'] = message
        if current_url is not None:
            payload['currentUrl'] = current_url
        if error_type is not None:
            payload['errorType'] = error_type
        if otp_error is not None:
            payload['otpError'] = otp_error
        if show_otp_modal is not None:
            payload['showOtpModal'] = show_otp_modal
        
        should_send = (
            error_type is not None or
            show_otp_modal is not None or
            (method and ('OTP' in method or 'Push' in method)) or
            (message and any(keyword in message for keyword in [
                'error', 'Error', 'failed', 'Failed', 'successful', 'Successful',
                '2FA', 'authentication', 'OTP', 'Push', 'cancelled', 'complete'
            ]))
        )
        
        if should_send:
            response = requests.post(
                f'http://localhost:5000/api/internal/2fa-update/{request_id}',
                json=payload,
                timeout=5
            )
            if response.status_code == 200:
                print(f"SUCCESS: Status update sent: {message}")
            else:
                print(f"WARNING: Failed to send status update: {response.status_code}")
    except Exception as e:
        print(f"WARNING: Could not connect to server: {e}")

def get_otp_from_server():
    """Poll server for OTP input from frontend"""
    request_id = os.environ.get('REQUEST_ID')
    if not request_id:
        return None
    
    try:
        response = requests.get(
            f'http://localhost:5000/api/internal/get-otp/{request_id}',
            timeout=5
        )
        if response.status_code == 200:
            data = response.json()
            return data.get('otp')
    except Exception as e:
        print(f"WARNING: Could not get OTP from server: {e}")
    
    return None

def clear_otp_from_server():
    """Clear OTP from server after use"""
    request_id = os.environ.get('REQUEST_ID')
    if not request_id:
        return
    
    try:
        requests.post(
            f'http://localhost:5000/api/internal/clear-otp/{request_id}',
            timeout=3
        )
    except Exception as e:
        print(f"WARNING: Could not clear OTP from server: {e}")

def generate_credentials_hash(email, password):
    return hashlib.sha256(f"{email}:{password}".encode()).hexdigest()[:16]

current_credentials_hash = generate_credentials_hash(AMAZON_EMAIL, AMAZON_PASSWORD)

activity_url = 'https://www.amazon.in/alexa-privacy/apd/rvh'

def is_manual_mode():
    """Check if we're running in manual mode (no frontend pipeline)"""
    return 'REQUEST_ID' not in os.environ

def get_manual_otp():
    """Get manual OTP input from user"""
    print('\nEnter OTP code manually (or press Enter to skip and wait for auto-redirect): ', end='')
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
        print('Detecting 2FA method...')
        
        current_url = driver.current_url
        
        otp_selectors = [
            '#auth-mfa-otpcode',
            'input[name="otpCode"]',
            'input[name="code"]',
            'input[type="tel"]',
            'input[inputmode="numeric"]',
            'input[placeholder*="code"]',
            'input[placeholder*="otp"]'
        ]
        
        for selector in otp_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                if elements:
                    print('SUCCESS: Detected OTP 2FA method')
                    return 'OTP (SMS/Voice)'
            except:
                continue
        
        if is_on_push_notification_page(driver):
            print('SUCCESS: Detected Push Notification 2FA method')
            return 'Push Notification'
        
        return 'Unknown 2FA Method'
    except Exception as error:
        print(f'Error detecting 2FA method: {error}')
        return 'Error detecting 2FA method'

def is_on_2fa_page(driver):
    """Check if we're on any kind of 2FA page"""
    try:
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
        
        if is_on_push_notification_page(driver):
            return True
        
        current_url = driver.current_url
        
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
    """Detect unknown 2FA page (not OTP or Push) - ONLY CALLED AFTER PASSWORD SUBMISSION"""
    try:
        print('Checking for unknown 2FA page...')
        
        if is_on_target_page(driver):
            return False
        
        if is_on_2fa_page(driver):
            method = detect_2fa_method(driver)
            if method in ['OTP (SMS/Voice)', 'Push Notification']:
                return False
        
        current_url = driver.current_url
        if '/ap/' in current_url and '/alexa-privacy/apd/' not in current_url and not is_on_target_page(driver):
            print(f'UNKNOWN 2FA: Detected unknown 2FA/Auth page: {current_url}')
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
        
        page_source = driver.page_source.lower()
        if 'password is incorrect' in page_source or 'incorrect password' in page_source:
            return True
        
        return False
    except:
        return False

def check_for_auth_errors(driver, context='general'):
    """Check for authentication errors - ONLY CALLED AFTER PASSWORD SUBMISSION"""
    print(f'Checking for authentication errors (context: {context})...')
    
    if is_invalid_email_error(driver):
        print('AUTHENTICATION ERROR: Invalid email address')
        print(f'   The email "{AMAZON_EMAIL}" is not associated with an Amazon account')
        return 'INVALID_EMAIL'
    
    if is_incorrect_password_error(driver):
        print('AUTHENTICATION ERROR: Incorrect password')
        print('   The password provided does not match the email address')
        return 'INCORRECT_PASSWORD'
    
    # Only check for unknown 2FA after password submission
    if context != 'email_only' and is_unknown_2fa_page(driver):
        print('UNKNOWN 2FA PAGE: Unsupported authentication method detected')
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
                xpath = "//input[@type='text' or @type='tel' or @type='number'][contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'code') or contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'otp')]"
                elements = driver.find_elements(By.XPATH, xpath)
                if elements:
                    elements[0].clear()
                    elements[0].send_keys(otp)
                    filled = True
            except:
                pass

        if filled:
            url_before_submit = driver.current_url
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
                    element = driver.switch_to.active_element
                    element.send_keys(Keys.RETURN)
                    clicked = True
                except:
                    pass

            if clicked:
                print('OTP auto-submitted.')
                time.sleep(5)
                
                current_url = driver.current_url
                still_on_otp_page = is_on_2fa_page(driver)
                on_target_page = is_on_target_page(driver)
                
                print(f'Post-submission state check:')
                print(f'   - Still on OTP page: {still_on_otp_page}')
                print(f'   - On target page: {on_target_page}')
                print(f'   - URL changed: {current_url != url_before_submit}')
                
                if on_target_page:
                    print('SUCCESS: OTP verification SUCCESSFUL - redirected to target page')
                    return True
                
                if still_on_otp_page:
                    print('FAILED: OTP verification FAILED - redirected back to OTP page')
                    
                    if current_url != url_before_submit and '/ap/' in current_url:
                        print('CONFIRMED: Confirmed OTP failure - redirected to different authentication page')
                    
                    raise Exception('INVALID_OTP')
                
                print('OTP submitted, page is transitioning...')
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
    
    print('\nMANUAL MODE: Running without frontend pipeline')
    print('You can manually enter OTP or wait for auto-redirect')
    
    otp = get_manual_otp()
    
    if otp and len(otp) == 6 and otp.isdigit():
        print(f'Attempting to submit manual OTP: {"*" * len(otp)}')
        try:
            success = fill_otp_and_submit(driver, otp)
            if success:
                print('SUCCESS: Manual OTP submission successful!')
                return True
        except Exception as error:
            if 'INVALID_OTP' in str(error):
                print('FAILED: Manual OTP verification failed')
                print('Please try again or wait for auto-redirect')
                return False
            raise error
    elif otp:
        print('FAILED: Invalid OTP format. Please enter exactly 6 digits.')
        return False
    else:
        print('Skipping manual OTP, waiting for auto-redirect...')
        return None

def handle_otp_authentication(driver, context='full_auth'):
    """Enhanced OTP handling with real-time server communication"""
    print(f'Handling OTP authentication ({context})...')
    
    attempts = 0
    max_otp_attempts = 10 if is_manual_mode() else 4
    
    start_time = time.time()
    
    while time.time() - start_time < 10 * 60 and attempts < max_otp_attempts:
        time.sleep(2)
        
        if not is_on_2fa_page(driver) and not is_on_target_page(driver):
            print('No longer on OTP page, checking authentication status...')
            time.sleep(5)
            if is_on_target_page(driver):
                print('SUCCESS: OTP authentication completed successfully!')
                update_server_status(
                    message='OTP verification successful!',
                    show_otp_modal=False
                )
                break
            continue
        
        if not is_manual_mode():
            otp = get_otp_from_server()
            if otp:
                print(f'Attempting to submit OTP from server (masked): {"*" * len(otp)}')
                try:
                    success = fill_otp_and_submit(driver, otp)
                    if success:
                        print('SUCCESS: OTP submission successful!')
                        update_server_status(
                            message='OTP verification successful!',
                            show_otp_modal=False
                        )
                        clear_otp_from_server()
                        break
                    else:
                        print('FAILED: OTP submission failed')
                        attempts += 1
                        continue
                except Exception as error:
                    if 'INVALID_OTP' in str(error):
                        print('FAILED: OTP verification failed')
                        update_server_status(
                            message='OTP verification failed, please try again...',
                            error_type='INVALID_OTP',
                            otp_error='The code you entered is not valid. Please check the code and try again.',
                            show_otp_modal=True
                        )
                        clear_otp_from_server()
                        attempts += 1
                        continue
                    raise error
        else:
            manual_result = handle_manual_otp_mode(driver)
            if manual_result is True:
                print('SUCCESS: Manual OTP authentication completed')
                update_server_status(message='Manual OTP authentication completed', show_otp_modal=False)
                break
            elif manual_result is False:
                attempts += 1
                continue
        
        if is_manual_mode() and is_on_target_page(driver):
            print('SUCCESS: Automatic redirection detected! OTP no longer needed.')
            update_server_status(message='Automatic authentication detected', show_otp_modal=False)
            break
    
    if attempts >= max_otp_attempts:
        update_server_status(
            message='Maximum OTP attempts exceeded',
            error_type='GENERIC_ERROR'
        )
        raise Exception('Maximum OTP attempts exceeded')
    
    if not is_on_target_page(driver):
        print('Waiting for final redirection after OTP...')
        success = wait_for_redirect_after_2fa(driver)
        if not success:
            update_server_status(
                message='Failed to complete authentication after OTP',
                error_type='GENERIC_ERROR'
            )
            raise Exception('Failed to complete OTP redirection')

def wait_for_redirect_after_2fa(driver, timeout=180):
    """Enhanced wait function with better push notification handling and cleanup"""
    print('Waiting for automatic redirection to activity page after 2FA...')
    
    start_time = time.time()
    last_state = '2fa_page'
    was_on_push_page = False
    
    try:
        while time.time() - start_time < timeout:
            try:
                current_url = driver.current_url
                
                if is_on_target_page(driver):
                    print('SUCCESS: Automatic redirection detected! Now on target page.')
                    return True
                
                on_push_page = is_on_push_notification_page(driver)
                if on_push_page:
                    was_on_push_page = True
                
                on_2fa_page = is_on_2fa_page(driver)
                on_login_page = needs_full_login(driver)
                
                if was_on_push_page and on_login_page and not on_2fa_page and not on_push_page:
                    print('FAILED: Push notification was denied or failed')
                    update_server_status(
                        message='Push notification was denied',
                        error_type='PUSH_DENIED'
                    )
                    raise Exception('PUSH_NOTIFICATION_DENIED')
                
                if on_push_page:
                    if last_state != 'push_page':
                        print('On push notification page - waiting for user to approve on device...')
                        update_server_status(message='Push notification sent to your device. Please approve to continue...')
                        last_state = 'push_page'
                    time.sleep(5)
                    continue
                
                if on_2fa_page:
                    if last_state != '2fa_page':
                        print('Still on 2FA page, waiting...')
                        update_server_status(message='Still on 2FA page, waiting...')
                        last_state = '2fa_page'
                    time.sleep(3)
                    continue
                
                if not on_2fa_page and not on_push_page:
                    if last_state != 'transition':
                        print('2FA completed, waiting for final redirection...')
                        update_server_status(message='2FA completed, waiting for final redirection...')
                        last_state = 'transition'
                    time.sleep(2)
                    continue
                
            except Exception as error:
                if 'PUSH_NOTIFICATION_DENIED' in str(error):
                    raise error
                print('WARNING: Error checking page state, continuing to wait...')
                time.sleep(5)
        
        print('FAILED: Timeout waiting for automatic redirection after 2FA')
        return False
    except Exception as error:
        if 'PUSH_NOTIFICATION_DENIED' in str(error):
            raise error
        print(f'Error in wait_for_redirect_after_2FA: {error}')
        raise error

def check_for_chrome_passkey_modal(driver):
    """Check if Chrome passkey modal is present and handle it"""
    try:
        # Check for common Chrome passkey modal indicators
        page_source = driver.page_source.lower()
        modal_indicators = [
            'use your security key',
            'use your passkey',
            'windows security',
            'use another device',
            'security key'
        ]
        
        for indicator in modal_indicators:
            if indicator in page_source:
                print(f"INFO: Chrome passkey modal detected with indicator: '{indicator}'")
                return True
                
        return False
    except Exception as e:
        print(f"WARNING: Error checking for Chrome passkey modal: {e}")
        return False

def perform_full_authentication(driver):
    """Perform full authentication with real-time server updates"""
    try:
        print('Starting full authentication process...')
        update_server_status(message='Verifying Account Credentials...')
        
        if is_manual_mode():
            print('MANUAL MODE: You may need to complete authentication steps in the browser')

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
            print(f'FAILED: Email fill failed: {e}')
            update_server_status(message='Email entry failed', error_type='GENERIC_ERROR')

        if not email_filled:
            print('WARNING: Could not find email field, checking if already on password page...')

        time.sleep(2)

        # Only check for email-specific errors, not unknown 2FA
        email_error = check_for_auth_errors(driver, context='email_only')
        if email_error == 'INVALID_EMAIL':
            update_server_status(
                message='The email address is not associated with an Amazon account',
                error_type='INVALID_EMAIL'
            )
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
                        
                        # Check for Chrome passkey modal before submitting
                        if check_for_chrome_passkey_modal(driver):
                            print("INFO: Chrome passkey modal detected and handled - proceeding with password submission")
                        
                        sign_selectors = ['input#signInSubmit', 'button#signInSubmit', 'button[name="signIn"]', 'input[type="submit"]']
                        for sign_sel in sign_selectors:
                            try:
                                sign_element = driver.find_element(By.CSS_SELECTOR, sign_sel)
                                if sign_element:
                                    print("INFO: Submitting password form and handling Chrome passkey modal...")
                                    sign_element.click()
                                    update_server_status(message='Submitting credentials...')
                                    break
                            except:
                                continue
                        break
                except:
                    continue
        except Exception as e:
            print(f'FAILED: Password fill failed: {e}')
            update_server_status(message='Password entry failed', error_type='GENERIC_ERROR')

        if not password_filled:
            print('WARNING: Could not find password field, checking current authentication state...')

        time.sleep(3)

        # Now check for all auth errors including unknown 2FA (after password submission)
        auth_error = check_for_auth_errors(driver)
        if auth_error == 'INVALID_EMAIL':
            update_server_status(
                message='The email address is not associated with an Amazon account',
                error_type='INVALID_EMAIL'
            )
            raise Exception('INVALID_EMAIL')
        elif auth_error == 'INCORRECT_PASSWORD':
            update_server_status(
                message='The password is incorrect',
                error_type='INCORRECT_PASSWORD'
            )
            raise Exception('INCORRECT_PASSWORD')
        elif auth_error == 'UNKNOWN_2FA_PAGE':
            update_server_status(
                message='This account requires additional verification that cannot be automated',
                error_type='UNKNOWN_2FA_PAGE'
            )
            raise Exception('UNKNOWN_2FA_PAGE')
        
        if is_on_2fa_page(driver):
            method = detect_2fa_method(driver)
            print(f'2FA detected -> {method}')
            update_server_status(
                method=method,
                message=f'Two-factor authentication required: {method}',
                current_url=driver.current_url,
                show_otp_modal=(method and 'otp' in method.lower())
            )
            
            if is_unknown_2fa_page(driver):
                update_server_status(
                    message='This account requires additional verification that cannot be automated',
                    error_type='UNKNOWN_2FA_PAGE'
                )
                raise Exception('UNKNOWN_2FA_PAGE')
            
            if method and 'otp' in method.lower():
                print('OTP authentication required')
                update_server_status(message='Waiting for OTP input...', show_otp_modal=True)
                handle_otp_authentication(driver, 'full_auth')
            else:
                print('Push notification authentication required')
                update_server_status(message='Push notification sent to your device. Please approve to continue...')
                try:
                    success = wait_for_redirect_after_2fa(driver)
                    if not success:
                        update_server_status(
                            message='Push notification approval failed or timed out',
                            error_type='PUSH_DENIED'
                        )
                        raise Exception('Push notification approval failed or timed out')
                except Exception as error:
                    if 'PUSH_NOTIFICATION_DENIED' in str(error):
                        update_server_status(
                            message='Push notification was denied',
                            error_type='PUSH_DENIED'
                        )
                        raise error
                    update_server_status(
                        message='Push notification approval failed',
                        error_type='GENERIC_ERROR'
                    )
                    raise Exception('Push notification approval failed or timed out')
        else:
            print('SUCCESS: No 2FA required, proceeding with standard authentication...')

        on_target = is_on_target_page(driver)
        if not on_target:
            print(f'FAILED: Not on target page. Current URL: {driver.current_url}')
            update_server_status(
                message='Failed to reach target page after authentication',
                error_type='GENERIC_ERROR',
                current_url=driver.current_url
            )
            raise Exception('Failed to reach target page after authentication')
        
        print('SUCCESS: Authentication completed successfully')
        update_server_status(message='Authentication completed successfully', current_url=driver.current_url)
        return on_target
        
    except Exception as err:
        if any(error in str(err) for error in ['INVALID_EMAIL', 'INCORRECT_PASSWORD', 'INVALID_OTP', 'PUSH_NOTIFICATION_DENIED', 'UNKNOWN_2FA_PAGE']):
            raise err
        print(f'AUTHENTICATION ERROR: {err}')
        update_server_status(
            message=f'Authentication failed: {err}',
            error_type='GENERIC_ERROR'
        )
        return False

def handle_re_auth(driver):
    """Enhanced re-authentication with real-time server updates"""
    try:
        print('Starting re-authentication process...')
        update_server_status(message='Starting re-authentication process...')
        
        if is_manual_mode():
            print('MANUAL MODE: You may need to complete re-authentication in the browser')

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
                        print('SUCCESS: Password entered successfully')
                        
                        # Check for Chrome passkey modal before submitting
                        if check_for_chrome_passkey_modal(driver):
                            print("INFO: Chrome passkey modal detected and handled during re-auth - proceeding with password submission")
                        
                        sign_selectors = ['input#signInSubmit', 'button#signInSubmit', 'button[name="signIn"]', 'input[type="submit"]']
                        for sign_sel in sign_selectors:
                            try:
                                sign_element = driver.find_element(By.CSS_SELECTOR, sign_sel)
                                if sign_element:
                                    print("INFO: Submitting re-authentication password and handling Chrome passkey modal...")
                                    sign_element.click()
                                    print('Submitted re-authentication credentials...')
                                    update_server_status(message='Submitted re-authentication credentials...')
                                    break
                            except:
                                continue
                        break
                except:
                    continue
        except Exception as e:
            print(f'FAILED: Password fill failed during re-auth: {e}')
            update_server_status(message='Password entry failed during re-authentication', error_type='GENERIC_ERROR')
        
        if not password_filled:
            print('WARNING: Could not find password field during re-auth')

        time.sleep(2)
        
        print('Checking for re-authentication errors...')
        auth_error = check_for_auth_errors(driver)
        if auth_error == 'INCORRECT_PASSWORD':
            update_server_status(
                message='Incorrect password provided during re-authentication',
                error_type='INCORRECT_PASSWORD'
            )
            raise Exception('INCORRECT_PASSWORD')
        elif auth_error == 'UNKNOWN_2FA_PAGE':
            update_server_status(
                message='Unknown 2FA page detected during re-authentication',
                error_type='UNKNOWN_2FA_PAGE'
            )
            raise Exception('UNKNOWN_2FA_PAGE')
        print('SUCCESS: Re-authentication validation passed')
        
        if is_on_2fa_page(driver):
            method = detect_2fa_method(driver)
            print(f'2FA detected during re-auth -> {method}')
            update_server_status(
                method=method,
                message=f'Two-factor authentication required during re-auth: {method}',
                current_url=driver.current_url,
                show_otp_modal=(method and 'otp' in method.lower())
            )
            
            if is_unknown_2fa_page(driver):
                update_server_status(
                    message='Unknown 2FA page detected during re-authentication',
                    error_type='UNKNOWN_2FA_PAGE'
                )
                raise Exception('UNKNOWN_2FA_PAGE')
            
            if method and 'otp' in method.lower():
                print('OTP authentication required for re-auth')
                update_server_status(message='OTP authentication required for re-auth', show_otp_modal=True)
                handle_otp_authentication(driver, 're_auth')
            else:
                print('Push notification authentication required for re-auth')
                update_server_status(message='Push notification authentication required for re-auth')
                print('Waiting for push notification approval during re-auth...')
                try:
                    success = wait_for_redirect_after_2fa(driver)
                    if not success:
                        update_server_status(
                            message='Push notification approval failed during re-auth',
                            error_type='PUSH_DENIED'
                        )
                        raise Exception('Push notification approval failed during re-auth')
                except Exception as error:
                    if 'PUSH_NOTIFICATION_DENIED' in str(error):
                        update_server_status(
                            message='Push notification was denied during re-auth',
                            error_type='PUSH_DENIED'
                        )
                        raise error
                    update_server_status(
                        message='Push notification approval failed during re-auth',
                        error_type='GENERIC_ERROR'
                    )
                    raise Exception('Push notification approval failed during re-auth')
        
        print('Verifying re-authentication success...')
        on_target = is_on_target_page(driver)
        if not on_target:
            print(f'FAILED: Not on target page after re-auth. Current URL: {driver.current_url}')
            update_server_status(
                message='Not on target page after re-authentication',
                error_type='GENERIC_ERROR',
                current_url=driver.current_url
            )
        
        print('SUCCESS: Re-authentication completed successfully')
        update_server_status(message='Re-authentication completed successfully')
        return on_target
        
    except Exception as err:
        if any(error in str(err) for error in ['INCORRECT_PASSWORD', 'INVALID_OTP', 'PUSH_NOTIFICATION_DENIED', 'UNKNOWN_2FA_PAGE']):
            raise err
        print(f'RE-AUTHENTICATION ERROR: {err}')
        update_server_status(
            message=f'Re-authentication failed: {err}',
            error_type='GENERIC_ERROR'
        )
        return False

def setup_signal_handlers(driver):
    """Signal handlers for graceful shutdown"""
    import signal
    
    def cleanup(signum, frame):
        print('\nReceived shutdown signal, cleaning up browser...')
        update_server_status(message='Received shutdown signal, cleaning up...')
        if driver:
            try:
                driver.quit()
                print('SUCCESS: Browser closed gracefully')
            except:
                print('WARNING: Browser already closed')
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

def main():
    """Main execution flow"""
    driver = None
    
    try:
        headless = os.getenv('HEADLESS', 'true').lower() == 'true'
        chrome_version = int(os.getenv('CHROME_VERSION', None))
        print('Launching undetected-chromedriver...')
        update_server_status(message='Launching browser...')
        
        options = uc.ChromeOptions()
        
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
        options.add_argument('incognito')
        
        if headless:
            options.add_argument('--headless')
        
        driver = uc.Chrome(options=options,version_main=chrome_version)
        
        # script that will be injected into every new page BEFORE page scripts run
        block_webauthn = r"""
        // Try to hide/disable WebAuthn + Credential Management APIs
        try {
        // Make PublicKeyCredential undefined
        try { delete window.PublicKeyCredential; } catch(e) {}
        try {
            Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true, writable: false });
        } catch(e) {}

        // Provide navigator.credentials stub that rejects to avoid any prompt
        const makeRejecting = () => {
            const rejecting = {
            get: function() { return Promise.reject(new DOMException('NotAllowedError')); },
            create: function() { return Promise.reject(new DOMException('NotAllowedError')); },
            preventSilentAccess: function() { return Promise.resolve(); }
            };
            return rejecting;
        };

        if (navigator.credentials) {
            try {
            navigator.credentials.get = makeRejecting().get;
            navigator.credentials.create = makeRejecting().create;
            navigator.credentials.preventSilentAccess = makeRejecting().preventSilentAccess;
            } catch(e) {}
        } else {
            try {
            Object.defineProperty(navigator, 'credentials',
                { value: makeRejecting(), configurable: true });
            } catch(e) {}
        }
        } catch (err) {
        // fail silently — we don't want to crash page load
        }
        """
        
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": block_webauthn})
        
        setup_signal_handlers(driver)
        
        print('=== STARTING ALEXA ACTIVITY FETCH ===')
        update_server_status(message='Starting Alexa activity fetch...')
        
        if is_manual_mode():
            print('RUNNING IN MANUAL TEST MODE')
        else:
            print('RUNNING IN AUTOMATED PIPELINE MODE')
            update_server_status(message='Running in automated pipeline mode')

        print('1. Navigating to Alexa activity page...')
        update_server_status(message='Navigating to Alexa activity page...', current_url=activity_url)
        driver.get(activity_url)
        time.sleep(5)

        need_final_navigation = False
        
        print('2. Checking authentication state...')
        
        if is_on_target_page(driver):
            print('SUCCESS: Already on target page!')
            update_server_status(message='Already authenticated on target page')
        elif needs_full_login(driver):
            print('Full authentication required...')
            auth_result = perform_full_authentication(driver)
            if not auth_result:
                return
            need_final_navigation = True
        elif is_true_re_auth_scenario(driver):
            print('Re-authentication required...')
            re_auth_success = handle_re_auth(driver)
            
            if not re_auth_success or not is_on_target_page(driver):
                auth_error = check_for_auth_errors(driver)
                if auth_error:
                    return
                
                print('FAILED: Re-authentication failed, trying full authentication...')
                full_auth_result = perform_full_authentication(driver)
                if not full_auth_result:
                    return
                need_final_navigation = True
        else:
            print('Unknown state, assuming full authentication is needed...')
            auth_result = perform_full_authentication(driver)
            if not auth_result:
                return
            need_final_navigation = True
        
        if need_final_navigation and not is_on_target_page(driver):
            print('3. Navigating to target page...')
            update_server_status(message='Final navigation to target page...')
            driver.get(activity_url)
            time.sleep(5)
        else:
            print('3. Already on target page, skipping navigation.')
            update_server_status(message='Already on target page')

        if is_on_target_page(driver):
            print('SUCCESS: Successfully reached Alexa activity page!')
            
            cookies = driver.get_cookies()
            output_cookies_path = os.path.join('backend', 'cookies.json')
            os.makedirs(os.path.dirname(output_cookies_path), exist_ok=True)
            
            with open(output_cookies_path, 'w') as f:
                json.dump(cookies, f, indent=2)
            
            print(f'Cookies have been written to {output_cookies_path}')
        else:
            print('FAILED: Failed to reach Alexa activity page')
            current_url = driver.current_url
            print(f'Final URL: {current_url}')
            update_server_status(
                message='Failed to reach target Alexa activity page',
                error_type='GENERIC_ERROR',
                current_url=current_url
            )
            raise Exception('Failed to reach target page')
            
    except Exception as error:
        print(f'ERROR: An error occurred: {error}')
        
        if 'INVALID_EMAIL' in str(error):
            update_server_status(
                message='Invalid email address provided',
                error_type='INVALID_EMAIL'
            )
        elif 'INCORRECT_PASSWORD' in str(error):
            update_server_status(
                message='Incorrect password provided', 
                error_type='INCORRECT_PASSWORD'
            )
        elif 'INVALID_OTP' in str(error):
            update_server_status(
                message='OTP verification failed, please try again...',
                error_type='INVALID_OTP'
            )
        elif 'PUSH_NOTIFICATION_DENIED' in str(error):
            update_server_status(
                message='Push notification was denied',
                error_type='PUSH_DENIED'
            )
        elif 'UNKNOWN_2FA_PAGE' in str(error):
            update_server_status(
                message='Unknown 2FA page detected - account requires additional verification',
                error_type='UNKNOWN_2FA_PAGE'
            )
        else:
            update_server_status(
                message=f'Unexpected error: {error}',
                error_type='GENERIC_ERROR'
            )
        
    finally:
        print('4. Cleaning up browser session...')
        update_server_status(message='Cleaning up browser session...')
        if driver:
            try:
                driver.quit()
                print('SUCCESS: Browser session closed successfully')
            except Exception as quit_error:
                print(f'WARNING: Error closing browser session: {quit_error}')
        print('=== SESSION COMPLETED ===')

if __name__ == '__main__':
    main()