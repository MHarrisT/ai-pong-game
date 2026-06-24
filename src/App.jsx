import { useEffect, useRef, useState } from 'react';
import { supabase } from './lib/supabaseClient';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 500;
const PADDLE_WIDTH = 12;
const PADDLE_HEIGHT = 100;
const BALL_SIZE = 10;
const PADDLE_SPEED = 6;
const BROADCAST_INTERVAL_MS = 1000 / 60;
const WIN_SCORE = 11;
const MS_PER_HOST_TICK = 16.67; // approx host frame time, for velocity scaling
const GLOW_PAD = 24; // extra canvas margin so the blur isn't clipped

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
  s.ball.vx = scoringSide === 'p1' ? 4 : -4;
  let vy = (Math.random() - 0.5) * 6;
  if (Math.abs(vy) < 1) vy = vy < 0 ? -1 : 1;
  s.ball.vy = vy;
  s.serving = true;
  s.serveAt = performance.now() + 1000;
}

function bounceAngle(ballY, paddleY) {
  const relativeIntersect = (ballY - paddleY) / PADDLE_HEIGHT - 0.5;
  return relativeIntersect * 4;
}

function resetGame(s) {
  s.score = { p1: 0, p2: 0 };
  s.gameOver = null;
  serveBall(s, Math.random() < 0.5 ? 'p1' : 'p2');
}

function makeInitialState() {
  return {
    myPaddleY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
    opponentPaddleY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
    ball: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2, vx: 4, vy: 3 },
    bothConnected: false,
    score: { p1: 0, p2: 0 },
    serving: false,
    serveAt: 0,
    gameOver: null,
    matchRowId: null,
    remote: {
      paddle: {
        prevY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
        targetY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
        receivedAt: 0,
        interval: BROADCAST_INTERVAL_MS,
      },
      ball: {
        prev: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
        target: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2, vx: 0, vy: 0 },
        renderX: CANVAS_WIDTH / 2,   
        renderY: CANVAS_HEIGHT / 2,
        receivedAt: 0,
        interval: BROADCAST_INTERVAL_MS,
      },
    },
  };
}

function draw(ctx, s, isHost, renderOpponentPaddleY, ballSprite, paddleSprite) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const leftPaddleY = isHost ? s.myPaddleY : renderOpponentPaddleY;
  const rightPaddleY = isHost ? renderOpponentPaddleY : s.myPaddleY;

  if (paddleSprite) {
    ctx.drawImage(paddleSprite, 20 - GLOW_PAD, leftPaddleY - GLOW_PAD);
    ctx.drawImage(
      paddleSprite,
      CANVAS_WIDTH - 20 - PADDLE_WIDTH - GLOW_PAD,
      rightPaddleY - GLOW_PAD
    );
  }

  if (s.bothConnected && !s.gameOver && ballSprite) {
    ctx.drawImage(ballSprite, s.ball.x - GLOW_PAD, s.ball.y - GLOW_PAD);
  }
}

export default function App() {
  const canvasRef = useRef(null);
  const channelRef = useRef(null);
  const channelReadyRef = useRef(false);
  const rafRef = useRef(null);
  const lastBroadcastRef = useRef(0);
  const lastWinnerRef = useRef(null);
  const keysRef = useRef({ up: false, down: false });
  const stateRef = useRef(makeInitialState());
  const scoreRef = useRef(null);
  const statusOverlayRef = useRef(null);
  const ballSpriteRef = useRef(null);
  const paddleSpriteRef = useRef(null);
  const lastPaddleSentRef = useRef(
  CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2
);

  const [{ roomCode, isHost }] = useState(resolveRoom);
  const [status, setStatus] = useState('connecting');
  const [winner, setWinner] = useState(null);

  // ✅ FIXED: Sprite Generation extracted to the top level
  useEffect(() => {
    // Ball sprite
    const ballCanvas = document.createElement('canvas');
    ballCanvas.width = BALL_SIZE + GLOW_PAD * 2;
    ballCanvas.height = BALL_SIZE + GLOW_PAD * 2;
    const bctx = ballCanvas.getContext('2d');
    bctx.shadowColor = '#0ff';
    bctx.shadowBlur = 20;
    bctx.fillStyle = '#fff';
    bctx.fillRect(GLOW_PAD, GLOW_PAD, BALL_SIZE, BALL_SIZE);
    ballSpriteRef.current = ballCanvas;

    // Paddle sprite
    const paddleCanvas = document.createElement('canvas');
    paddleCanvas.width = PADDLE_WIDTH + GLOW_PAD * 2;
    paddleCanvas.height = PADDLE_HEIGHT + GLOW_PAD * 2;
    const pctx = paddleCanvas.getContext('2d');
    pctx.shadowColor = '#0ff';
    pctx.shadowBlur = 20;
    pctx.fillStyle = '#fff';
    pctx.fillRect(GLOW_PAD, GLOW_PAD, PADDLE_WIDTH, PADDLE_HEIGHT);
    paddleSpriteRef.current = paddleCanvas;
  }, []);

  useEffect(() => {
    const channel = supabase.channel(`room_${roomCode}`, {
      config: {
        broadcast: { self: false },
        presence: { key: isHost ? 'p1' : 'p2' },
      },
    });

    channel.on('broadcast', { event: 'p1_state' }, ({ payload }) => {
      if (isHost) return;
      const s = stateRef.current;
      const now = performance.now();

      const paddleGap = s.remote.paddle.receivedAt
        ? now - s.remote.paddle.receivedAt
        : BROADCAST_INTERVAL_MS;
      s.remote.paddle.interval = clamp(paddleGap, 16, 200);
      s.remote.paddle.prevY = s.remote.paddle.targetY;
      s.remote.paddle.targetY = payload.paddleY;
      s.remote.paddle.receivedAt = now;

      const ballGap = s.remote.ball.receivedAt
        ? now - s.remote.ball.receivedAt
        : BROADCAST_INTERVAL_MS;
      s.remote.ball.interval = clamp(ballGap, 16, 200);
      s.remote.ball.prev = { ...s.remote.ball.target };
      s.remote.ball.target = { ...payload.ball };
      s.remote.ball.receivedAt = now;

      s.score = payload.score;
      s.serving = payload.serving;
      s.gameOver = payload.gameOver;
    });

    channel.on('broadcast', { event: 'p2_state' }, ({ payload }) => {
      if (!isHost) return;
      const s = stateRef.current;
      const now = performance.now();

      const paddleGap = s.remote.paddle.receivedAt
        ? now - s.remote.paddle.receivedAt
        : BROADCAST_INTERVAL_MS;
      s.remote.paddle.interval = clamp(paddleGap, 16, 200);
      s.opponentPaddleY = payload.paddleY;
      s.remote.paddle.prevY = s.remote.paddle.targetY;
      s.remote.paddle.targetY = payload.paddleY;
      s.remote.paddle.receivedAt = now;
    });

    channel.on('broadcast', { event: 'restart_request' }, () => {
      if (isHost) resetGame(stateRef.current);
    });

    channel.on('presence', { event: 'sync' }, () => {
      const peers = Object.keys(channel.presenceState());
      const ready = peers.includes('p1') && peers.includes('p2');
      const s = stateRef.current;
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

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'ArrowUp') keysRef.current.up = true;
      if (e.key === 'ArrowDown') keysRef.current.down = true;
    };
    const onKeyUp = (e) => {
      if (e.key === 'ArrowUp') keysRef.current.up = false;
      if (e.key === 'ArrowDown') keysRef.current.down = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const loop = (timestamp) => {
      const s = stateRef.current;

      if (keysRef.current.up) s.myPaddleY = Math.max(0, s.myPaddleY - PADDLE_SPEED);
      if (keysRef.current.down)
        s.myPaddleY = Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT, s.myPaddleY + PADDLE_SPEED);

      if (isHost && s.bothConnected && !s.gameOver) {
        if (s.serving) {
          if (performance.now() >= s.serveAt) s.serving = false;
        } else {
          const ball = s.ball;
          ball.x += ball.vx;
          ball.y += ball.vy;

          if (ball.y <= 0 || ball.y >= CANVAS_HEIGHT - BALL_SIZE) ball.vy *= -1;

          const leftPaddleX = 20;
          if (
            ball.vx < 0 &&
            ball.x <= leftPaddleX + PADDLE_WIDTH &&
            ball.x + BALL_SIZE >= leftPaddleX &&
            ball.y + BALL_SIZE >= s.myPaddleY &&
            ball.y <= s.myPaddleY + PADDLE_HEIGHT
          ) {
            ball.x = leftPaddleX + PADDLE_WIDTH;
            ball.vx *= -1.05;
            ball.vy += bounceAngle(ball.y, s.myPaddleY);
            ball.vy = clamp(ball.vy, -12, 12);
          }

          const rightPaddleX = CANVAS_WIDTH - 20 - PADDLE_WIDTH;
          if (
            ball.vx > 0 &&
            ball.x + BALL_SIZE >= rightPaddleX &&
            ball.x <= rightPaddleX + PADDLE_WIDTH &&
            ball.y + BALL_SIZE >= s.opponentPaddleY &&
            ball.y <= s.opponentPaddleY + PADDLE_HEIGHT
          ) {
            ball.x = rightPaddleX - BALL_SIZE;
            ball.vx *= -1.05;
            ball.vy += bounceAngle(ball.y, s.opponentPaddleY);
            ball.vy = clamp(ball.vy, -12, 12);
          }

          if (ball.x < 0) {
            s.score.p2 += 1;
            if (s.score.p2 >= WIN_SCORE) s.gameOver = 'p2';
            else serveBall(s, 'p2');
          } else if (ball.x > CANVAS_WIDTH - BALL_SIZE) {
            s.score.p1 += 1;
            if (s.score.p1 >= WIN_SCORE) s.gameOver = 'p1';
            else serveBall(s, 'p1');
          }
        }
      }

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

      let renderOpponentPaddleY = s.opponentPaddleY;

      if (!isHost) {
        const now = performance.now();
        const remote = s.remote;

        const paddleElapsed = now - remote.paddle.receivedAt;
        const paddleDuration = remote.paddle.interval;
        const paddleT = clamp(paddleElapsed / paddleDuration, 0, 1);
        const paddleRate = (remote.paddle.targetY - remote.paddle.prevY) / paddleDuration;
        const paddleOvershoot = Math.max(paddleElapsed - paddleDuration, 0);

        renderOpponentPaddleY = clamp(
          lerp(remote.paddle.prevY, remote.paddle.targetY, paddleT) +
            paddleRate * Math.min(paddleOvershoot, 80), 
          0,
          CANVAS_HEIGHT - PADDLE_HEIGHT
        );

        const dt = Math.min(now - remote.ball.receivedAt, 150); // cap extrapolation if a packet is late/dropped

        const predictedX =
          remote.ball.target.x +
          remote.ball.target.vx * (dt / MS_PER_HOST_TICK);

        const predictedY =
          remote.ball.target.y +
          remote.ball.target.vy * (dt / MS_PER_HOST_TICK);

        remote.ball.renderX += (predictedX - remote.ball.renderX) * 0.20;
        remote.ball.renderY += (predictedY - remote.ball.renderY) * 0.20;

        s.ball = {
          x: remote.ball.renderX,
          y: remote.ball.renderY,
          vx: remote.ball.target.vx,
          vy: remote.ball.target.vy,
        };
      }

      if (timestamp - lastBroadcastRef.current >= BROADCAST_INTERVAL_MS) {
        lastBroadcastRef.current = timestamp;
        const channel = channelRef.current;
        if (channel && channelReadyRef.current) {
          if (isHost) {
            channel.send({
              type: 'broadcast',
              event: 'p1_state',
              payload: {
                paddleY: s.myPaddleY,
                ball: s.ball,
                score: s.score,
                serving: s.serving,
                gameOver: s.gameOver,
              },
            });
          } else {
            if (
              Math.abs(s.myPaddleY - lastPaddleSentRef.current) > 1
            ) {
              lastPaddleSentRef.current = s.myPaddleY;

              channel.send({
                type: 'broadcast',
                event: 'p2_state',
                payload: { paddleY: s.myPaddleY },
              });
            }
          }
        }
      }

      draw(ctx, s, isHost, renderOpponentPaddleY, ballSpriteRef.current, paddleSpriteRef.current);

      if (scoreRef.current) scoreRef.current.textContent = `${s.score.p1} — ${s.score.p2}`;
      if (statusOverlayRef.current) {
        let msg = '';
        if (!s.bothConnected) msg = 'WAITING FOR OPPONENT…';
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