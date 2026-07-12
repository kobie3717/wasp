/**
 * WaSP Health Monitoring Example
 *
 * Demonstrates the proactive "pong timer" health monitor that fires
 * on an interval and alerts when sessions become stale.
 *
 * Run: npx tsx examples/health-monitoring.ts
 */

import { WaSP, WaspHealthMonitor } from '../src/index.js';

async function main() {
  // Option 1: Auto-start health monitor via config
  const wasp = new WaSP({
    debug: true,
    healthMonitor: {
      intervalMs: 5 * 60 * 1000,      // Check every 5 minutes
      stalenessThresholdMs: 5 * 60 * 1000, // Alert if no messages for 5 minutes
      logMemory: true,                 // Log heap usage on each tick
    },
  });

  // Option 2: Manual health monitor creation
  // const wasp = new WaSP({ debug: true });
  // const monitor = new WaspHealthMonitor(wasp, {
  //   intervalMs: 5 * 60 * 1000,
  //   stalenessThresholdMs: 5 * 60 * 1000,
  //   logMemory: true,
  // });
  // monitor.start();

  // Listen for health events
  wasp.on('health:tick' as any, (event) => {
    console.log('\n[HEALTH TICK]', new Date().toISOString());
    console.log('Sessions:', event.data.sessions.length);

    for (const session of event.data.sessions) {
      const status = session.connected ? '✅ Connected' : '❌ Disconnected';
      const staleness = session.staleSinceMs
        ? `⚠️  Stale for ${Math.round(session.staleSinceMs / 1000)}s`
        : '✅ Fresh';

      console.log(`  - ${session.id}: ${status}, ${staleness}`);
    }

    if (event.data.memory) {
      const heapUsedMB = Math.round(event.data.memory.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(event.data.memory.heapTotal / 1024 / 1024);
      console.log(`Memory: ${heapUsedMB}MB / ${heapTotalMB}MB`);
    }
  });

  wasp.on('health:degraded' as any, (event) => {
    console.error('\n[SESSION DEGRADED] 🚨');
    console.error('Session:', event.data.sessionId);
    console.error('Stale since:', Math.round(event.data.staleSinceMs / 1000), 'seconds');
    console.error('Last activity:', event.data.lastActivityAt);

    // Example: Send alert, restart session, etc.
    // await sendSlackAlert(`Session ${event.data.sessionId} is stale!`);
    // await wasp.destroySession(event.data.sessionId);
    // await wasp.createSession(event.data.sessionId, 'BAILEYS');
  });

  wasp.on('health:recovered' as any, (event) => {
    console.log('\n[SESSION RECOVERED] ✅');
    console.log('Session:', event.data.sessionId);
    console.log('Last activity:', event.data.lastActivityAt);
  });

  // Create a test session
  const session = await wasp.createSession('demo-session', 'BAILEYS');
  console.log('\nSession created:', session.id);

  // Listen for messages to update lastActivityAt
  wasp.on('MESSAGE_RECEIVED', async (event) => {
    console.log('\n[MESSAGE]', event.data.content);
  });

  // Keep alive
  console.log('\nHealth monitor running...');
  console.log('Staleness threshold: 5 minutes');
  console.log('Check interval: 5 minutes');
  console.log('\nPress Ctrl+C to exit\n');

  // Example: Simulate session going stale after 10 minutes
  // setTimeout(async () => {
  //   console.log('\n[SIMULATION] Simulating stale session (no messages for 10 min)...');
  //   await wasp.sessions.update('demo-session', {
  //     lastActivityAt: new Date(Date.now() - 10 * 60 * 1000),
  //   });
  // }, 60000); // After 1 minute
}

main().catch(console.error);
