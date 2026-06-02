/**
 * Ban Risk Detection Example
 *
 * Shows how to use WaSP's ban_risk_high event to detect and respond to
 * elevated ban risk in real-time.
 */

import { WaSP, EventType, BanRiskEvent } from '../src/index.js';

// Initialize WaSP with ban risk detector enabled
const wasp = new WaSP({
  debug: true,
  banRiskDetector: {
    enabled: true,
    checkInterval: 30000, // Check every 30 seconds
    rapidRestartThreshold: 3, // Alert after 3 restarts in 5 min
    highErrorRatePercent: 10, // Alert if >10% messages fail
    disconnectThreshold: 5, // Alert after 5 disconnects in 10 min
    qrRescanThreshold: 3, // Alert after 3 QR scans in 10 min
  },
});

// Create a session
async function main() {
  const sessionId = 'example-session';

  try {
    // Create session (Baileys provider)
    const session = await wasp.createSession(sessionId, 'BAILEYS', {
      // Baileys options here
    });

    console.log('Session created:', session.id);

    // Listen for ban risk events
    wasp.on(EventType.BAN_RISK_HIGH, (event) => {
      const riskEvent = event.data as BanRiskEvent;

      console.error('⚠️  BAN RISK DETECTED ⚠️');
      console.error(`Session: ${riskEvent.sessionId}`);
      console.error(`Risk Level: ${riskEvent.riskLevel.toUpperCase()}`);
      console.error(`Signals: ${riskEvent.signals.join(', ')}`);
      console.error(`Recommendation: ${riskEvent.recommendation}`);
      console.error('---');

      // Take action based on risk level
      if (riskEvent.riskLevel === 'critical') {
        handleCriticalRisk(riskEvent);
      } else if (riskEvent.riskLevel === 'high') {
        handleHighRisk(riskEvent);
      } else {
        handleMediumRisk(riskEvent);
      }
    });

    // Listen for other events
    wasp.on(EventType.MESSAGE_RECEIVED, (event) => {
      console.log('Message received:', event.data);
    });

    wasp.on(EventType.SESSION_DISCONNECTED, (event) => {
      console.log('Session disconnected:', event.data);
    });

    wasp.on(EventType.SESSION_ERROR, (event) => {
      console.error('Session error:', event.data);
    });

    console.log('Bot running. Press Ctrl+C to exit.');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

/**
 * Handle critical ban risk (score 80-100 or reachout restricted)
 */
async function handleCriticalRisk(event: BanRiskEvent) {
  console.error('🚨 CRITICAL RISK - Taking immediate action');

  // Option 1: Stop all activity
  console.log('Pausing all message sending for 2 hours...');
  // await wasp.pauseSession(event.sessionId, 2 * 60 * 60 * 1000);

  // Option 2: Destroy session and wait before reconnecting
  console.log('Destroying session. Wait 2-4 hours before reconnecting.');
  // await wasp.destroySession(event.sessionId);

  // Option 3: Send alert to admin
  await sendAdminAlert({
    level: 'critical',
    sessionId: event.sessionId,
    signals: event.signals,
    recommendation: event.recommendation,
  });
}

/**
 * Handle high ban risk (score 60-79)
 */
async function handleHighRisk(event: BanRiskEvent) {
  console.warn('⚠️  HIGH RISK - Reducing activity');

  // Increase message delays
  console.log('Increasing message delays to 10-20 seconds...');
  // await wasp.updateQueueConfig(event.sessionId, {
  //   minDelay: 10000,
  //   maxDelay: 20000,
  // });

  // Pause for 30 minutes
  console.log('Pausing for 30 minutes...');
  // await wasp.pauseSession(event.sessionId, 30 * 60 * 1000);

  // Send alert
  await sendAdminAlert({
    level: 'high',
    sessionId: event.sessionId,
    signals: event.signals,
    recommendation: event.recommendation,
  });
}

/**
 * Handle medium ban risk (score 40-59)
 */
async function handleMediumRisk(event: BanRiskEvent) {
  console.warn('⚠️  MEDIUM RISK - Monitoring closely');

  // Log for monitoring
  console.log('Signals detected:', event.signals);

  // Optional: reduce message rate slightly
  // await wasp.updateQueueConfig(event.sessionId, {
  //   minDelay: 5000,
  //   maxDelay: 10000,
  // });

  // Send low-priority alert
  await sendAdminAlert({
    level: 'medium',
    sessionId: event.sessionId,
    signals: event.signals,
    recommendation: event.recommendation,
  });
}

/**
 * Send alert to admin (webhook, email, Slack, etc.)
 */
async function sendAdminAlert(alert: {
  level: 'critical' | 'high' | 'medium';
  sessionId: string;
  signals: string[];
  recommendation: string;
}) {
  // Example: POST to webhook
  try {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (!webhookUrl) {
      console.log('No webhook URL configured, skipping alert');
      return;
    }

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Ban Risk Alert: ${alert.level.toUpperCase()}`,
        sessionId: alert.sessionId,
        signals: alert.signals,
        recommendation: alert.recommendation,
        timestamp: new Date().toISOString(),
      }),
    });

    console.log('Alert sent to admin');
  } catch (error) {
    console.error('Failed to send alert:', error);
  }
}

/**
 * Manual ban risk check example
 */
async function checkBanRisk(sessionId: string) {
  const riskEvent = await wasp.banRiskDetector.checkSession(sessionId);

  if (riskEvent) {
    console.log('Manual check — risk detected:');
    console.log(riskEvent);
  } else {
    console.log('Manual check — no risk detected');
  }
}

// Run the example
main().catch(console.error);

// Example: Manual risk check every 5 minutes
setInterval(async () => {
  const sessions = wasp.getSessions();
  for (const sessionId of sessions) {
    await checkBanRisk(sessionId);
  }
}, 5 * 60 * 1000);
