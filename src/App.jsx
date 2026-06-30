import { useEffect, useRef, useState } from 'react';
import { supabase } from './lib/supabaseClient';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 500;
const PADDLE_WIDTH = 12;
const PADDLE_HEIGHT = 100;
const BALL_SIZE = 10;

const PADDLE_SPEED_PX_S = 360;
const BALL_SERVE_SPEED_PX_S = 240;
const BALL_VY_RANGE_PX_S = 360;
const BALL_VY_MIN_PX_S = 60;
const BALL_VX_MAX_PX_S = 840;
const BALL_VY_MAX_PX_S = 720;
const BOUNCE_ANGLE_FACTOR_PX_S = 240;

// 60 Hz broadcast — halves extrapolation error window vs 30 Hz
const BROADCAST_INTERVAL_MS = 1000 / 60;
const WIN_SCORE = 11;
const GLOW_PAD = 24;
// Grace window: how long (ms) we wait after the ball crosses the right edge
// before awarding P1 a point. This compensates for network round-trip delay.
const MISS_GRACE_MS = 120;
// Vertical tolerance for the pendingMiss check. P2 positions their paddle based
// on their extrapolated ball Y, which can differ from the host's Y by up to
// ~vy × one-way-latency (720 px/s × 50ms ≈ 36px). This covers that gap.
const MISS_Y_MARGIN = 40;
const MAX_DT_MS = 50;

function resolveRoom() {
  const params = new URLSearchParams(window.location.search);
  const existing = params.get('room');
  if (existing) return { roomCode: existing.toUpperCase(), isHost: false };

  const code = Array.from({ length: 4 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]
  ).join('');
  params.set('room', code);
  window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
  return { roomCode: code, isHost: true };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function serveBall(s, scoringSide) {
  s.ball.x = CANVAS_WIDTH / 2 - BALL_SIZE / 2;
  s.ball.y = CANVAS_HEIGHT / 2 - BALL_SIZE / 2;
  s.ball.vx = scoringSide === 'p1' ? BALL_SERVE_SPEED_PX_S : -BALL_SERVE_SPEED_PX_S;
  let vy = (Math.random() - 0.5) * BALL_VY_RANGE_PX_S;
  if (Math.abs(vy) < BALL_VY_MIN_PX_S) vy = vy < 0 ? -BALL_VY_MIN_PX_S : BALL_VY_MIN_PX_S;
  s.ball.vy = vy;
  s.serving = true;
  s.serveAt = performance.now() + 1000;
}

function bounceAngle(ballY, paddleY) {
  const relativeIntersect = (ballY - paddleY) / PADDLE_HEIGHT - 0.5;
  return relativeIntersect * BOUNCE_ANGLE_FACTOR_PX_S;
}

// Extrapolate ball position forward by dtMs milliseconds, correctly simulating
// top/bottom wall bounces. This keeps P2's local view in sync with the host
// even between broadcasts — the old linear clamp caused desync at walls.
function extrapolateBall(target, dtMs) {
  let { x, y, vx, vy } = target;
  let remaining = dtMs / 1000;

  for (let step = 0; step < 8 && remaining > 0.0001; step++) {
    // Time to the next top or bottom wall bounce
    let tWall = Infinity;
    if (vy > 0) {
      tWall = (CANVAS_HEIGHT - BALL_SIZE - y) / vy;
    } else if (vy < 0) {
      tWall = -y / vy;
    }

    if (tWall > 0 && tWall <= remaining) {
      x += vx * tWall;
      y += vy * tWall;
      vy *= -1;          // wall bounce
      remaining -= tWall;
    } else {
      x += vx * remaining;
      y += vy * remaining;
      remaining = 0;
    }
  }

  return {
    x: clamp(x, 0, CANVAS_WIDTH - BALL_SIZE),
    y: clamp(y, 0, CANVAS_HEIGHT - BALL_SIZE),
    vx,
    vy,
  };
}

function resetGame(s) {
  s.score = { p1: 0, p2: 0 };
  s.gameOver = null;
  s.pendingMiss = null;
  serveBall(s, Math.random() < 0.5 ? 'p1' : 'p2');
}

function makeInitialState() {
  return {
    myPaddleY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
    opponentPaddleY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
    ball: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2, vx: BALL_SERVE_SPEED_PX_S, vy: 180 },
    bothConnected: false,
    score: { p1: 0, p2: 0 },
    serving: false,
    serveAt: 0,
    gameOver: null,
    // When ball crosses the right edge, we record position + timestamp here.
    // Each frame we check if P2's latest paddle now covers that Y — if yes it's
    // a hit; if MISS_GRACE_MS expires without a cover it's a point for P1.
    pendingMiss: null,
    matchRowId: null,
    remote: {
      paddle: {
        prevY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
        targetY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
        receivedAt: 0,
        interval: BROADCAST_INTERVAL_MS,
      },
      ball: {
        target: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2, vx: 0, vy: 0 },
        receivedAt: 0,
        // Start frozen so P2 never extrapolates a stale pre-game ball state
        // before the first real broadcast with serving:true arrives.
        frozen: true,
      },
    },
  };
}

// P1 (left) draws red, P2 (right) draws cyan — sprites are pre-rendered
// once on mount so we never recompute shadowBlur during the render loop.
function draw(ctx, s, isHost, renderOpponentPaddleY, ballSprite, paddleSpriteP1, paddleSpriteP2) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const leftPaddleY  = isHost ? s.myPaddleY : renderOpponentPaddleY; // always P1
  const rightPaddleY = isHost ? renderOpponentPaddleY : s.myPaddleY; // always P2

  if (paddleSpriteP1) {
    ctx.drawImage(paddleSpriteP1, 20 - GLOW_PAD, leftPaddleY - GLOW_PAD);
  }
  if (paddleSpriteP2) {
    ctx.drawImage(
      paddleSpriteP2,
      CANVAS_WIDTH - 20 - PADDLE_WIDTH - GLOW_PAD,
      rightPaddleY - GLOW_PAD
    );
  }

  if (s.bothConnected && !s.gameOver && ballSprite) {
    ctx.drawImage(ballSprite, s.ball.x - GLOW_PAD, s.ball.y - GLOW_PAD);
  }
}

export default function App() {
  const canvasRef         = useRef(null);
  const channelRef        = useRef(null);
  const channelReadyRef   = useRef(false);
  const rafRef            = useRef(null);
  const lastFrameRef      = useRef(null);
  const lastBroadcastRef  = useRef(0);
  const lastWinnerRef     = useRef(null);
  const keysRef           = useRef({ up: false, down: false });
  const stateRef          = useRef(makeInitialState());
  const scoreRef          = useRef(null);
  const statusOverlayRef  = useRef(null);
  const ballSpriteRef     = useRef(null);
  const paddleSpriteP1Ref = useRef(null); // red
  const paddleSpriteP2Ref = useRef(null); // cyan
  const lastPaddleSentRef = useRef(CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2);

  const [{ roomCode, isHost }] = useState(resolveRoom);
  const [status, setStatus]    = useState('connecting');
  const [winner, setWinner]    = useState(null);

  // Build glow sprites once on mount
  useEffect(() => {
    const ballCanvas = document.createElement('canvas');
    ballCanvas.width  = BALL_SIZE + GLOW_PAD * 2;
    ballCanvas.height = BALL_SIZE + GLOW_PAD * 2;
    const bctx = ballCanvas.getContext('2d');
    bctx.shadowColor = '#0ff';
    bctx.shadowBlur  = 20;
    bctx.fillStyle   = '#fff';
    bctx.fillRect(GLOW_PAD, GLOW_PAD, BALL_SIZE, BALL_SIZE);
    ballSpriteRef.current = ballCanvas;

    const p1Canvas = document.createElement('canvas');
    p1Canvas.width  = PADDLE_WIDTH + GLOW_PAD * 2;
    p1Canvas.height = PADDLE_HEIGHT + GLOW_PAD * 2;
    const p1ctx = p1Canvas.getContext('2d');
    p1ctx.shadowColor = '#f00';
    p1ctx.shadowBlur  = 20;
    p1ctx.fillStyle   = '#ff3333';
    p1ctx.fillRect(GLOW_PAD, GLOW_PAD, PADDLE_WIDTH, PADDLE_HEIGHT);
    paddleSpriteP1Ref.current = p1Canvas;

    const p2Canvas = document.createElement('canvas');
    p2Canvas.width  = PADDLE_WIDTH + GLOW_PAD * 2;
    p2Canvas.height = PADDLE_HEIGHT + GLOW_PAD * 2;
    const p2ctx = p2Canvas.getContext('2d');
    p2ctx.shadowColor = '#0ff';
    p2ctx.shadowBlur  = 20;
    p2ctx.fillStyle   = '#fff';
    p2ctx.fillRect(GLOW_PAD, GLOW_PAD, PADDLE_WIDTH, PADDLE_HEIGHT);
    paddleSpriteP2Ref.current = p2Canvas;
  }, []);

  // --- Channel join + presence ---
  useEffect(() => {
    const channel = supabase.channel(`room_${roomCode}`, {
      config: {
        broadcast: { self: false },
        presence: { key: isHost ? 'p1' : 'p2' },
      },
    });

    channel.on('broadcast', { event: 'p1_state' }, ({ payload }) => {
      if (isHost) return;
      const s   = stateRef.current;
      const now = performance.now();

      const paddleGap = s.remote.paddle.receivedAt
        ? now - s.remote.paddle.receivedAt
        : BROADCAST_INTERVAL_MS;
      s.remote.paddle.interval    = clamp(paddleGap, 16, 300);
      s.remote.paddle.prevY       = s.remote.paddle.targetY;
      s.remote.paddle.targetY     = payload.paddleY;
      s.remote.paddle.receivedAt  = now;

      s.remote.ball.target     = payload.ball;
      s.remote.ball.receivedAt = now;
      s.remote.ball.frozen     = payload.ballFrozen;

      s.score    = payload.score;
      s.serving  = payload.serving;
      s.gameOver = payload.gameOver;
    });

    channel.on('broadcast', { event: 'p2_state' }, ({ payload }) => {
      if (!isHost) return;
      const s   = stateRef.current;
      const now = performance.now();

      const paddleGap = s.remote.paddle.receivedAt
        ? now - s.remote.paddle.receivedAt
        : BROADCAST_INTERVAL_MS;
      s.remote.paddle.interval   = clamp(paddleGap, 16, 300);
      // Always update opponentPaddleY immediately so the pendingMiss check
      // always uses P2's freshest known position.
      s.opponentPaddleY          = payload.paddleY;
      s.remote.paddle.prevY      = s.remote.paddle.targetY;
      s.remote.paddle.targetY    = payload.paddleY;
      s.remote.paddle.receivedAt = now;
    });

    channel.on('broadcast', { event: 'restart_request' }, () => {
      if (isHost) resetGame(stateRef.current);
    });

    channel.on('presence', { event: 'sync' }, () => {
      const peers    = Object.keys(channel.presenceState());
      const ready    = peers.includes('p1') && peers.includes('p2');
      const s        = stateRef.current;
      const wasReady = s.bothConnected;

      s.bothConnected = ready;
      setStatus(ready ? 'connected' : 'waiting');

      if (ready && !wasReady && isHost) {
        resetGame(s);
        supabase
          .from('game_sessions')
          .insert({ player_1_ready: true, player_2_ready: true, score_1: 0, score_2: 0 })
          .select('id')
          .single()
          .then(({ data, error }) => {
            if (error) console.error('Failed to create game session:', error);
            else s.matchRowId = data.id;
          });
      }
    });

    channel.subscribe((subStatus) => {
      if (subStatus === 'SUBSCRIBED') {
        channelReadyRef.current = true;
        channel.track({ online: true });
      }
    });

    channelRef.current = channel;

    return () => {
      channelReadyRef.current = false;
      supabase.removeChannel(channel);
    };
  }, [roomCode, isHost]);

  // --- Keyboard input ---
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'ArrowUp')   keysRef.current.up   = true;
      if (e.key === 'ArrowDown') keysRef.current.down = true;
    };
    const onKeyUp = (e) => {
      if (e.key === 'ArrowUp')   keysRef.current.up   = false;
      if (e.key === 'ArrowDown') keysRef.current.down = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
    };
  }, []);

  // --- Game loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext('2d');

    const loop = (timestamp) => {
      const s = stateRef.current;

      const dtMs =
        lastFrameRef.current == null
          ? 0
          : Math.min(timestamp - lastFrameRef.current, MAX_DT_MS);
      lastFrameRef.current = timestamp;
      const dtSec = dtMs / 1000;

      // ── Local paddle movement (both players) ──────────────────────────────
      if (keysRef.current.up)
        s.myPaddleY = Math.max(0, s.myPaddleY - PADDLE_SPEED_PX_S * dtSec);
      if (keysRef.current.down)
        s.myPaddleY = Math.min(
          CANVAS_HEIGHT - PADDLE_HEIGHT,
          s.myPaddleY + PADDLE_SPEED_PX_S * dtSec
        );

      // ── HOST (P1) authoritative physics ───────────────────────────────────
      if (isHost && s.bothConnected && !s.gameOver) {

        if (s.serving) {
          // Ball is frozen until serve timer elapses
          if (performance.now() >= s.serveAt) s.serving = false;

        } else if (s.pendingMiss) {
          // Ball just crossed the right edge. We hold here for MISS_GRACE_MS,
          // checking every frame whether P2's latest received paddle now covers
          // the ball's crossing Y. No hitbox inflation — exact paddle bounds.
          const elapsed      = performance.now() - s.pendingMiss.crossedAt;
          const liveOpponentY = s.opponentPaddleY; // real-time, no prediction

          const saved =
            s.pendingMiss.y + BALL_SIZE >= liveOpponentY - MISS_Y_MARGIN &&
            s.pendingMiss.y             <= liveOpponentY + PADDLE_HEIGHT + MISS_Y_MARGIN;

          if (saved) {
            // P2's paddle reached the ball — register a hit and reflect.
            const rightPaddleX = CANVAS_WIDTH - 20 - PADDLE_WIDTH;
            s.ball.x = rightPaddleX - BALL_SIZE;
            s.ball.y = s.pendingMiss.y;
            s.ball.vx *= -1.05;
            s.ball.vx  = clamp(s.ball.vx, -BALL_VX_MAX_PX_S, BALL_VX_MAX_PX_S);
            s.ball.vy += bounceAngle(s.pendingMiss.y, liveOpponentY);
            s.ball.vy  = clamp(s.ball.vy, -BALL_VY_MAX_PX_S, BALL_VY_MAX_PX_S);
            s.pendingMiss = null;
          } else if (elapsed >= MISS_GRACE_MS) {
            // Grace window expired — P2 definitely missed.
            s.pendingMiss = null;
            s.score.p1 += 1;
            if (s.score.p1 >= WIN_SCORE) s.gameOver = 'p1';
            else serveBall(s, 'p1');
          }
          // (While pendingMiss is active the ball is frozen in place, so P2's
          //  interpolated view on their screen also stops advancing.)

        } else {
          // ── Normal ball physics ──────────────────────────────────────────
          const ball = s.ball;
          ball.x += ball.vx * dtSec;
          ball.y += ball.vy * dtSec;

          // Top / bottom wall
          if (ball.y <= 0 || ball.y >= CANVAS_HEIGHT - BALL_SIZE) ball.vy *= -1;

          // ── P1 (left) paddle — real-time, exact hitbox ──────────────────
          const leftPaddleX = 20;
          if (
            ball.vx < 0 &&
            ball.x           <= leftPaddleX + PADDLE_WIDTH &&
            ball.x + BALL_SIZE >= leftPaddleX &&
            ball.y + BALL_SIZE >= s.myPaddleY &&
            ball.y             <= s.myPaddleY + PADDLE_HEIGHT
          ) {
            ball.x  = leftPaddleX + PADDLE_WIDTH;
            ball.vx *= -1.05;
            ball.vx  = clamp(ball.vx, -BALL_VX_MAX_PX_S, BALL_VX_MAX_PX_S);
            ball.vy += bounceAngle(ball.y, s.myPaddleY);
            ball.vy  = clamp(ball.vy, -BALL_VY_MAX_PX_S, BALL_VY_MAX_PX_S);
          }

          // ── P2 (right) paddle — real-time, exact hitbox ─────────────────
          // Uses s.opponentPaddleY: the latest position received from P2,
          // updated every broadcast (~33 ms). No prediction, no hit-margin.
          const rightPaddleX = CANVAS_WIDTH - 20 - PADDLE_WIDTH;
          if (
            ball.vx > 0 &&
            ball.x + BALL_SIZE >= rightPaddleX &&
            ball.x             <= rightPaddleX + PADDLE_WIDTH &&
            ball.y + BALL_SIZE >= s.opponentPaddleY &&
            ball.y             <= s.opponentPaddleY + PADDLE_HEIGHT
          ) {
            ball.x  = rightPaddleX - BALL_SIZE;
            ball.vx *= -1.05;
            ball.vx  = clamp(ball.vx, -BALL_VX_MAX_PX_S, BALL_VX_MAX_PX_S);
            ball.vy += bounceAngle(ball.y, s.opponentPaddleY);
            ball.vy  = clamp(ball.vy, -BALL_VY_MAX_PX_S, BALL_VY_MAX_PX_S);
          }

          // ── Scoring / miss detection ─────────────────────────────────────
          if (ball.x < 0) {
            // Ball exited left — P1 missed
            s.score.p2 += 1;
            if (s.score.p2 >= WIN_SCORE) s.gameOver = 'p2';
            else serveBall(s, 'p2');
          } else if (ball.x > CANVAS_WIDTH - BALL_SIZE) {
            // Ball crossed the right edge — start grace window for P2
            s.pendingMiss = { y: ball.y, crossedAt: performance.now() };
          }
        }
      }

      // ── Winner detection ───────────────────────────────────────────────────
      if (s.gameOver !== lastWinnerRef.current) {
        lastWinnerRef.current = s.gameOver;
        setWinner(s.gameOver);

        if (s.gameOver && isHost && s.matchRowId) {
          supabase
            .from('game_sessions')
            .update({ score_1: s.score.p1, score_2: s.score.p2 })
            .eq('id', s.matchRowId)
            .then(({ error }) => {
              if (error) console.error('Failed to save final score:', error);
            });
        }
      }

      // ── Render-only: smooth opponent paddle position ───────────────────────
      let renderOpponentPaddleY;

      if (isHost) {
        // P1 renders P2's paddle using latest received + short linear prediction
        const remotePaddle    = s.remote.paddle;
        const paddleElapsedNow = performance.now() - remotePaddle.receivedAt;
        const paddleRateNow   =
          (remotePaddle.targetY - remotePaddle.prevY) / remotePaddle.interval;
        renderOpponentPaddleY = clamp(
          remotePaddle.targetY + paddleRateNow * Math.min(paddleElapsedNow, 100),
          0,
          CANVAS_HEIGHT - PADDLE_HEIGHT
        );
      } else {
        // P2 renders P1's paddle with lerp + overshoot compensation
        const now    = performance.now();
        const remote = s.remote;

        const paddleElapsed  = now - remote.paddle.receivedAt;
        const paddleDuration = remote.paddle.interval;
        const paddleT        = clamp(paddleElapsed / paddleDuration, 0, 1);
        const paddleRate     = (remote.paddle.targetY - remote.paddle.prevY) / paddleDuration;
        const paddleOvershoot = Math.max(paddleElapsed - paddleDuration, 0);

        renderOpponentPaddleY = clamp(
          lerp(remote.paddle.prevY, remote.paddle.targetY, paddleT) +
            paddleRate * Math.min(paddleOvershoot, 80),
          0,
          CANVAS_HEIGHT - PADDLE_HEIGHT
        );

        // P2 extrapolates ball position forward from the last host broadcast.
        // ballFrozen is true while pendingMiss is active, so P2's ball also
        // P2 extrapolates ball forward from the last host broadcast,
        // simulating wall bounces so the view stays in sync between updates.
        // ballFrozen=true means pendingMiss is active — ball is pinned at edge.
        const ballDt = remote.ball.frozen
          ? 0
          : Math.min(now - remote.ball.receivedAt, 200);

        s.ball = remote.ball.frozen
          ? { ...remote.ball.target }
          : extrapolateBall(remote.ball.target, ballDt);
      }

      // ── Broadcast ─────────────────────────────────────────────────────────
      if (timestamp - lastBroadcastRef.current >= BROADCAST_INTERVAL_MS) {
        lastBroadcastRef.current = timestamp;
        const channel = channelRef.current;
        if (channel && channelReadyRef.current) {
          if (isHost) {
            // Only broadcast once both players are connected.
            // The host's initial ball state (vx ≠ 0) must NOT reach P2 before
            // the serve countdown, otherwise P2 extrapolates the ball mid-air.
            if (s.bothConnected) {
              channel.send({
                type:  'broadcast',
                event: 'p1_state',
                payload: {
                  paddleY:    s.myPaddleY,
                  ball:       s.ball,
                  // ballFrozen=true freezes P2's extrapolation during serve / pendingMiss
                  ballFrozen: s.serving || !!s.pendingMiss,
                  score:      s.score,
                  serving:    s.serving,
                  gameOver:   s.gameOver,
                },
              });
            }
          } else {
            // P2 always sends when position changed — host needs fresh data
            // so pendingMiss can resolve correctly.
            if (Math.abs(s.myPaddleY - lastPaddleSentRef.current) > 1) {
              lastPaddleSentRef.current = s.myPaddleY;
              channel.send({
                type:  'broadcast',
                event: 'p2_state',
                payload: { paddleY: s.myPaddleY },
              });
            }
          }
        }
      }

      draw(
        ctx, s, isHost, renderOpponentPaddleY,
        ballSpriteRef.current,
        paddleSpriteP1Ref.current,
        paddleSpriteP2Ref.current
      );

      if (scoreRef.current)
        scoreRef.current.textContent = `${s.score.p1} — ${s.score.p2}`;

      if (statusOverlayRef.current) {
        let msg = '';
        if (!s.bothConnected)            msg = 'WAITING FOR OPPONENT…';
        else if (s.serving && !s.gameOver) msg = 'GET READY…';
        statusOverlayRef.current.textContent = msg;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isHost]);

  function handleRestart() {
    if (isHost) {
      resetGame(stateRef.current);
    } else {
      channelRef.current?.send({ type: 'broadcast', event: 'restart_request', payload: {} });
    }
  }

  const youWon = winner && ((winner === 'p1' && isHost) || (winner === 'p2' && !isHost));

  return (
    <div style={{ textAlign: 'center', color: '#fff' }}>
      <p>
        Room: <strong>{roomCode}</strong> — you are{' '}
        <strong>{isHost ? 'Player 1' : 'Player 2'}</strong> — {status}
      </p>
      {status === 'waiting' && isHost && <p>Share this link: {window.location.href}</p>}

      <div style={{ position: 'relative', display: 'inline-block', fontFamily: "'Orbitron', sans-serif" }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          style={{ background: '#000', border: '1px solid #444' }}
        />

        <div
          ref={scoreRef}
          style={{
            position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
            fontSize: '32px', fontWeight: 700, color: '#0ff',
            textShadow: '0 0 10px #0ff, 0 0 20px rgba(0,255,255,0.6)',
            letterSpacing: '4px', pointerEvents: 'none',
          }}
        >
          0 — 0
        </div>

        <div
          ref={statusOverlayRef}
          style={{
            position: 'absolute', top: '45%', left: '50%', transform: 'translateX(-50%)',
            fontSize: '18px', letterSpacing: '2px', color: '#888', pointerEvents: 'none',
          }}
        />

        {winner && (
          <div
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0, 0, 0, 0.75)', gap: '16px', fontFamily: "'Orbitron', sans-serif",
            }}
          >
            <h2 style={{ margin: 0, fontSize: '32px', color: '#0ff', textShadow: '0 0 12px #0ff' }}>
              {youWon ? 'YOU WIN! 🎉' : 'YOU LOSE'}
            </h2>
            <p style={{ margin: 0, opacity: 0.8, letterSpacing: '1px' }}>
              {winner === 'p1' ? 'PLAYER 1' : 'PLAYER 2'} REACHED {WIN_SCORE} POINTS
            </p>
            <button
              onClick={handleRestart}
              style={{
                padding: '10px 24px', fontSize: '16px', fontFamily: "'Orbitron', sans-serif",
                cursor: 'pointer', background: '#0ff', color: '#000', border: 'none',
                borderRadius: '6px', fontWeight: 700,
              }}
            >
              RESTART
            </button>
          </div>
        )}
      </div>
    </div>
  );
}