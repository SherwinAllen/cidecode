import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MatrixBackground, TeamInfo } from './Layout';
import { motion } from 'framer-motion';
import { 
  containerStyle,
  pageContentStyle,
  fancyHeadingStyle,
  spinnerStyle
} from '../constants/styles';
import { FaEye, FaEyeSlash } from 'react-icons/fa'; // Add this import at the top
import Modal from 'react-modal'; // optional; if not installed, use simple inline div modal

const SmartAssistant = () => {
  const [teamText, setTeamText] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);  // Loading state added
  const [showPassword, setShowPassword] = useState(false); // Add this state
  const [requestId, setRequestId] = useState(null);
  const [twoFAInfo, setTwoFAInfo] = useState(null);
  const [otpInput, setOtpInput] = useState('');
  const [show2FAModal, setShow2FAModal] = useState(false);
  const navigate = useNavigate();

  const teamInfo = `Team Name: paidRTOS\nTeam Members:\n\t1. Shambo Sarkar\n\t2. Sathvik S\n\t3. Sherwin Allen\n\t4. Meeran Ahmed`;

  // Typing animation for team info
  useEffect(() => {
    let currentIndex = 0;
    const typingInterval = setInterval(() => {
      setTeamText(teamInfo.slice(0, currentIndex + 1));
      currentIndex++;
      if (currentIndex >= teamInfo.length) clearInterval(typingInterval);
    }, 100);
    return () => clearInterval(typingInterval);
  }, []);

  // Simulate loading/initialization (similar to SmartWatch)
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Function to acquire data and trigger a file download.
  // Pass email, password and source=SmartAssistant as query parameters.
  const handleAcquireData = async () => {
    setError(null);

    if (!email.trim() || !password.trim()) {
      setError("Please fill in both Email and Password fields.");
      return;
    }

    setDownloading(true);
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

      // DO NOT show the 2FA modal immediately.
      // Start polling backend for 2FA detection; modal will open only after server reports method.
      poll2FAStatus(json.requestId);
    } catch (err) {
      console.error("Error acquiring data:", err);
      setError(err.message);
      setDownloading(false);
    }
  };

  // polling function
  async function poll2FAStatus(id) {
    try {
      let closed = false;
      while (!closed) {
        const res = await fetch(`http://localhost:5000/api/2fa-status/${id}`);
        if (!res.ok) throw new Error('Status fetch failed');
        const info = await res.json();

        // Update local twoFAInfo (keeps UI informed)
        setTwoFAInfo(info);

        // Only open modal when backend reports the detected 2FA method
        if (info.method && !show2FAModal) {
          setShow2FAModal(true);
        }

        // If pipeline finished, trigger download and close modal
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
          setDownloading(false);
          closed = true;
          break;
        }

        if (info.status === 'error') {
          setError(info.error || 'Error in backend pipeline');
          setShow2FAModal(false);
          setDownloading(false);
          closed = true;
          break;
        }

        // sleep before next poll
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error('Polling error', err);
      setError(err.message);
      setShow2FAModal(false);
      setDownloading(false);
    }
  }

  // OTP submit handler
  const submitOtp = async () => {
    if (!requestId) { setError('No active request'); return; }
    if (!otpInput || otpInput.trim().length < 4) {
      setError('Enter the OTP received.');
      return;
    }
    try {
      const res = await fetch(`http://localhost:5000/api/submit-otp/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: otpInput.trim() })
      });
      if (!res.ok) throw new Error('Failed to send OTP');
      setError(null);
      // keep modal open; backend/headless will pick up OTP and continue
    } catch (err) {
      setError('Failed to send OTP to server');
    }
  };

  // Non-OTP "I completed" button
  const confirm2FA = async () => {
    if (!requestId) { setError('No active request'); return; }
    try {
      const res = await fetch(`http://localhost:5000/api/confirm-2fa/${requestId}`, { method: 'POST' });
      if (!res.ok) throw new Error('Confirm failed');
      setError(null);
      // keep modal open; backend will proceed once it detects re-auth complete
    } catch (err) {
      setError('Failed to confirm 2FA');
    }
  };

  // New button style for a larger, more prominent look
  const bigButtonStyle = {
    width: '80%',
    padding: '20px',
    backgroundColor: '#0f0', // neon green
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

  // Hover effects for the buttons
  const bigButtonHover = {
    scale: 1.1,
    boxShadow: '0 0 30px rgba(0,255,0,1)'
  };

  const inputWrapperStyle = {
    width: '80%',
    margin: '20px auto 0 auto',
    display: 'block',
    height: '56px',
  };

  const passwordWrapperStyle = {
    width: '80%',
    margin: '20px auto 0 auto',
    position: 'relative',
    display: 'block',
    height: '56px',
  };

  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box', // Add this line
    padding: '15px 50px 15px 20px',
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    border: '2px solid #0f0',
    borderRadius: '10px',
    color: '#0f0',
    fontSize: '1.2rem',
    fontFamily: "'Orbitron', sans-serif",
    textAlign: 'center',
    boxShadow: '0 0 10px rgba(0,255,0,0.5)',
    outline: 'none',
  };

  const eyeIconStyle = {
    position: 'absolute',
    right: '20px',
    top: '50%',
    transform: 'translateY(-50%)',
    color: '#0f0',
    cursor: 'pointer',
    fontSize: '1.5rem',
    zIndex: 2,
    background: 'transparent',
    border: 'none',
    padding: 0,
  };

  if (loading) {
    return (
      <div style={containerStyle}>
        <MatrixBackground />
        <TeamInfo teamText={teamText} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
          <p style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: 24 }}>
            INITIALIZING SMART ASSISTANT...
          </p>
          <div style={spinnerStyle} />
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <MatrixBackground />
      <TeamInfo teamText={teamText} />
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={pageContentStyle}>
        <h1 style={{ ...fancyHeadingStyle, fontSize: '2.5rem', marginBottom: '48px' }}>
          SMART ASSISTANT DATA
        </h1>

        {error && (
          <p style={{ color: 'red', fontSize: '1.2rem' }}>{error}</p>
        )}

        {/* Email and Password input fields */}
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
                  <input
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value)}
                    placeholder="Enter 6-digit OTP"
                    style={{ width: '80%', padding: 10, margin: '12px 0', borderRadius: 6, border: '1px solid #0f0', background: '#000', color: '#0f0' }}
                  />
                  <div>
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
