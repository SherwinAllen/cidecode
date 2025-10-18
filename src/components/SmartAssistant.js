import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { MatrixBackground, TeamInfo } from './Layout';
import { motion } from 'framer-motion';
import { 
  containerStyle,
  pageContentStyle,
  fancyHeadingStyle,
  spinnerStyle
} from '../constants/styles';
import { FaEye, FaEyeSlash } from 'react-icons/fa';

const SmartAssistant = () => {
  const [teamText, setTeamText] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [requestId, setRequestId] = useState(null);
  const [twoFAInfo, setTwoFAInfo] = useState(null);
  const [show2FAModal, setShow2FAModal] = useState(false);
  const [otpSubmitted, setOtpSubmitted] = useState(false);
  const navigate = useNavigate();

  // Use refs for values that need to be fresh in polling
  const otpSubmittedRef = useRef(false);
  const pollingActiveRef = useRef(false);

  // OTP (6 boxes)
  const [otpDigits, setOtpDigits] = useState(Array(6).fill(''));
  const inputsRef = useRef([]);

  const teamInfo = `Team Name: paidRTOS\nTeam Members:\n\t1. Shambo Sarkar\n\t2. Sathvik S\n\t3. Sherwin Allen\n\t4. Meeran Ahmed`;

  useEffect(() => {
    let currentIndex = 0;
    const typingInterval = setInterval(() => {
      setTeamText(teamInfo.slice(0, currentIndex + 1));
      currentIndex++;
      if (currentIndex >= teamInfo.length) clearInterval(typingInterval);
    }, 100);
    return () => clearInterval(typingInterval);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  const handleAcquireData = async () => {
    setError(null);

    if (!email.trim() || !password.trim()) {
      setError("Please fill in both Email and Password fields.");
      return;
    }

    setDownloading(true);
    setOtpSubmitted(false);
    otpSubmittedRef.current = false; // Reset ref
    pollingActiveRef.current = true; // Start polling
    
    try {
      const response = await fetch('http://localhost:5000/api/packet-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, source: 'SmartAssistant' })
      });
      if (!response.ok) {
        throw new Error(`Failed to start pipeline: ${response.statusText}`);
      }
      const json = await response.json();
      if (!json.requestId) {
        throw new Error('No requestId returned from server');
      }
      setRequestId(json.requestId);

      // Start polling
      poll2FAStatus(json.requestId);
    } catch (err) {
      console.error("Error acquiring data:", err);
      setError(err.message);
      setDownloading(false);
      pollingActiveRef.current = false;
    }
  };

  // polling function
  async function poll2FAStatus(id) {
    try {
      while (pollingActiveRef.current) {
        const res = await fetch(`http://localhost:5000/api/2fa-status/${id}`);
        if (!res.ok) throw new Error('Status fetch failed');
        const info = await res.json();

        // keep UI informed
        setTwoFAInfo(info);

        // CRITICAL FIX: Only open modal if:
        // 1. Backend reports a method 
        // 2. Modal isn't already open
        // 3. OTP hasn't been submitted (using ref for fresh value)
        // 4. We're not in a completed state
        if (info.method && !show2FAModal && !otpSubmittedRef.current && !info.done && info.status !== 'error') {
          setShow2FAModal(true);
        }

        // pipeline finished -> download + cleanup
        if (info.done) {
          try {
            const dl = await fetch(`http://localhost:5000/api/download/${id}`);
            const blob = await dl.blob();
            const link = document.createElement('a');
            link.href = window.URL.createObjectURL(blob);
            link.download = 'matched_audio_transcripts.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(link.href);
          } catch (e) {
            console.error('Download failed', e);
            setError('Download failed');
          }
          setShow2FAModal(false);
          setOtpSubmitted(false);
          otpSubmittedRef.current = false;
          setDownloading(false);
          pollingActiveRef.current = false;
          break;
        }

        if (info.status === 'error') {
          setError(info.error || 'Error in backend pipeline');
          setShow2FAModal(false);
          setOtpSubmitted(false);
          otpSubmittedRef.current = false;
          setDownloading(false);
          pollingActiveRef.current = false;
          break;
        }

        // wait before next poll
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error('Polling error', err);
      setError(err.message);
      setShow2FAModal(false);
      setOtpSubmitted(false);
      otpSubmittedRef.current = false;
      setDownloading(false);
      pollingActiveRef.current = false;
    }
  }

  // assemble OTP
  const assembledOtp = () => otpDigits.join('').trim();

  // OTP submit handler - THIS IS THE KEY FIX
  const submitOtp = async () => {
    setError(null);
    const otp = assembledOtp();
    if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
      setError('Enter the full 6-digit OTP.');
      return;
    }
    if (!requestId) {
      setError('No active request');
      return;
    }

    // CRITICAL: Set BOTH state and ref to prevent modal reopening
    setOtpSubmitted(true);
    otpSubmittedRef.current = true; // This ensures polling sees the fresh value

    // Close the modal immediately and permanently for this session
    setShow2FAModal(false);

    // Clear OTP UI
    setOtpDigits(Array(6).fill(''));
    inputsRef.current.forEach((el) => { if (el) el.value = ''; });

    try {
      const res = await fetch(`http://localhost:5000/api/submit-otp/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp })
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => 'Failed to send OTP');
        setError(txt || 'Failed to send OTP');
        // Only allow reopening if there was an error
        setOtpSubmitted(false);
        otpSubmittedRef.current = false;
      }
      // If successful, otpSubmitted remains true and modal stays closed
    } catch (err) {
      console.error('Failed to send OTP', err);
      setError('Failed to send OTP to server');
      setOtpSubmitted(false);
      otpSubmittedRef.current = false;
    }
  };

  const confirm2FA = async () => {
    if (!requestId) { setError('No active request'); return; }
    try {
      const res = await fetch(`http://localhost:5000/api/confirm-2fa/${requestId}`, { method: 'POST' });
      if (!res.ok) throw new Error('Confirm failed');
      setError(null);
    } catch (err) {
      setError('Failed to confirm 2FA');
    }
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      pollingActiveRef.current = false;
    };
  }, []);

  // styles
  const bigButtonStyle = {
    width: '80%',
    padding: '20px',
    backgroundColor: '#0f0',
    border: 'none',
    color: '#000',
    cursor: 'pointer',
    fontSize: '1.5rem',
    borderRadius: '10px',
    margin: '20px auto',
    display: 'block',
    fontFamily: "'Orbitron', sans-serif",
    textTransform: 'uppercase',
    boxShadow: '0 0 20px rgba(0,255,0,0.7)',
    transition: 'transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out'
  };
  const bigButtonHover = { scale: 1.1, boxShadow: '0 0 30px rgba(0,255,0,1)' };
  const inputWrapperStyle = { width: '80%', margin: '20px auto 0 auto', display: 'block', height: '56px' };
  const passwordWrapperStyle = { width: '80%', margin: '20px auto 0 auto', position: 'relative', display: 'block', height: '56px' };
  const inputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '15px 50px 15px 20px',
    backgroundColor: 'rgba(0,0,0,0.8)', border: '2px solid #0f0', borderRadius: '10px',
    color: '#0f0', fontSize: '1.2rem', fontFamily: "'Orbitron', sans-serif",
    textAlign: 'center', boxShadow: '0 0 10px rgba(0,255,0,0.5)', outline: 'none',
  };
  const eyeIconStyle = { position: 'absolute', right: '20px', top: '50%', transform: 'translateY(-50%)', color: '#0f0', cursor: 'pointer', fontSize: '1.5rem', zIndex: 2, background: 'transparent', border: 'none', padding: 0 };
  const otpContainerStyle = { display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 };
  const otpBoxStyle = { width: 44, height: 54, textAlign: 'center', fontSize: 24, borderRadius: 6, border: '2px solid #0f0', background: '#000', color: '#0f0', outline: 'none', fontFamily: "'Orbitron', sans-serif", boxShadow: '0 0 8px rgba(0,255,0,0.3)' };

  if (loading) {
    return (
      <div style={containerStyle}>
        <MatrixBackground />
        <TeamInfo teamText={teamText} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
          <p style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: 24 }}>INITIALIZING SMART ASSISTANT...</p>
          <div style={spinnerStyle} />
        </div>
      </div>
    );
  }

  // OTP handlers
  const handleOtpChange = (e, idx) => {
    const val = e.target.value;
    if (!val) {
      const copy = [...otpDigits];
      copy[idx] = '';
      setOtpDigits(copy);
      return;
    }
    const digit = val.replace(/\D/g, '')[0];
    if (!digit) return;
    const copy = [...otpDigits];
    copy[idx] = digit;
    setOtpDigits(copy);
    if (idx < 5) {
      const next = inputsRef.current[idx + 1];
      if (next) next.focus();
    }
  };
  const handleOtpKeyDown = (e, idx) => {
    if (e.key === 'Backspace') {
      if (otpDigits[idx]) {
        const copy = [...otpDigits];
        copy[idx] = '';
        setOtpDigits(copy);
      } else if (idx > 0) {
        const prev = inputsRef.current[idx - 1];
        if (prev) {
          prev.focus();
          const copy = [...otpDigits];
          copy[idx - 1] = '';
          setOtpDigits(copy);
        }
      }
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      inputsRef.current[idx - 1]?.focus();
    } else if (e.key === 'ArrowRight' && idx < 5) {
      inputsRef.current[idx + 1]?.focus();
    }
  };
  const handleOtpPaste = (e, startIdx = 0) => {
    e.preventDefault();
    const paste = (e.clipboardData || window.clipboardData).getData('text');
    const digits = paste.replace(/\D/g, '').slice(0, 6);
    if (!digits) return;
    const copy = [...otpDigits];
    for (let i = 0; i < digits.length && startIdx + i < 6; i++) {
      copy[startIdx + i] = digits[i];
      if (inputsRef.current[startIdx + i]) {
        inputsRef.current[startIdx + i].value = digits[i];
      }
    }
    setOtpDigits(copy);
    const nextFocusIdx = Math.min(5, startIdx + digits.length);
    setTimeout(() => inputsRef.current[nextFocusIdx]?.focus(), 0);
  };

  return (
    <div style={containerStyle}>
      <MatrixBackground />
      <TeamInfo teamText={teamText} />
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={pageContentStyle}>
        <h1 style={{ ...fancyHeadingStyle, fontSize: '2.5rem', marginBottom: '48px' }}>SMART ASSISTANT DATA</h1>

        {error && <p style={{ color: 'red', fontSize: '1.2rem' }}>{error}</p>}

        <div style={inputWrapperStyle}>
          <input 
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div style={passwordWrapperStyle}>
          <input 
            type={showPassword ? "text" : "password"}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
          <button
            type="button"
            style={eyeIconStyle}
            onClick={() => setShowPassword((prev) => !prev)}
            tabIndex={0}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <FaEyeSlash /> : <FaEye />}
          </button>
        </div>

        <motion.button 
          onClick={handleAcquireData}
          style={bigButtonStyle}
          whileHover={bigButtonHover}
          disabled={downloading}
        >
          {downloading ? 'Acquiring Data...' : 'Acquire Data'}
        </motion.button>

        <motion.button 
          onClick={() => navigate('/iotextractor')}
          style={bigButtonStyle}
          whileHover={bigButtonHover}
        >
          Back to Devices
        </motion.button>

        {show2FAModal && (
          <div style={{
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
          }}>
            <div style={{ width: 420, padding: 24, background: '#000', border: '2px solid #0f0', borderRadius: 8, color: '#0f0', textAlign: 'center' }}>
              <h2>Two-Factor Authentication Required</h2>
              <p style={{ color: '#afa' }}>{twoFAInfo?.method || 'Waiting for detection...'}</p>
              <p style={{ fontSize: 14 }}>{twoFAInfo?.message || 'Please follow instructions on your device.'}</p>

              {twoFAInfo?.method && twoFAInfo.method.includes('OTP') ? (
                <>
                  <div style={otpContainerStyle} onPaste={(e) => handleOtpPaste(e, 0)}>
                    {Array.from({ length: 6 }).map((_, idx) => (
                      <input
                        key={idx}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        ref={(el) => (inputsRef.current[idx] = el)}
                        style={otpBoxStyle}
                        onChange={(e) => handleOtpChange(e, idx)}
                        onKeyDown={(e) => handleOtpKeyDown(e, idx)}
                        onPaste={(e) => handleOtpPaste(e, idx)}
                        value={otpDigits[idx]}
                        aria-label={`OTP digit ${idx + 1}`}
                      />
                    ))}
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <button onClick={submitOtp} style={{ marginRight: 8, padding: '10px 16px', background: '#0f0', color: '#000', borderRadius: 6 }}>Submit OTP</button>
                  </div>
                </>
              ) : (
                <>
                  <p>Waiting for you to finish verification on your device.</p>
                  <button onClick={confirm2FA} style={{ padding: '10px 16px', background: '#0f0', color: '#000', borderRadius: 6 }}>I completed</button>
                </>
              )}

              <div style={{ marginTop: 12 }}>
                <button onClick={() => { setShow2FAModal(false); }} style={{ padding: '8px 12px', background: 'transparent', color: '#0f0', border: '1px solid #0f0', borderRadius: 6 }}>Close</button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
};

export default SmartAssistant;