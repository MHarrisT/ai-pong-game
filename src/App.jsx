import { useEffect, useRef, useState } from 'react';
import { supabase } from './lib/supabaseClient';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 500;
const PADDLE_WIDTH = 12;
const PADDLE_HEIGHT = 100;
const BALL_SIZE = 10;
const PADDLE_SPEED = 6;
const BROADCAST_INTERVAL_MS = 1000 / 30; // 30fps
const WIN_SCORE = 11;

// --- Room resolution: generate, or read from ?room=ABCD ---
function resolveRoom() {
  const params = new URLSearchParams(window.location.search);
  const existing = params.get('room');

  if (existing) {
    return { roomCode: existing.toUpperCase(), isHost: false };
  }

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

// scoringSide = who just won the point. Ball serves toward the
// side that just lost, giving them the next touch.
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

// Resets score + ball, clears game-over state, serves fresh.
// Only ever called on the host (directly, or via a restart request).
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
    gameOver: null, // null | 'p1' | 'p2'
    remote: {
      paddle: {
        prevY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
        targetY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
        receivedAt: 0,
      },
      ball: {
        prev: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
        target: { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 },
        receivedAt: 0,
      },
    },
  };
}

  function draw(ctx, s, isHost, renderOpponentPaddleY) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const leftPaddleY = isHost ? s.myPaddleY : renderOpponentPaddleY;
    const rightPaddleY = isHost ? renderOpponentPaddleY : s.myPaddleY;

    ctx.fillStyle = '#fff';
    ctx.fillRect(20, leftPaddleY, PADDLE_WIDTH, PADDLE_HEIGHT);
    ctx.fillRect(CANVAS_WIDTH - 20 - PADDLE_WIDTH, rightPaddleY, PADDLE_WIDTH, PADDLE_HEIGHT);

    ctx.font = '28px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${s.score.p1}   ${s.score.p2}`, CANVAS_WIDTH / 2, 40);

    if (!s.bothConnected) {
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#888';
      ctx.fillText('Waiting for opponent…', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
      return;
    }

    if (s.serving && !s.gameOver) {
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#888';
      ctx.fillText('Get ready…', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 30);
    }

    if (!s.gameOver) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(s.ball.x, s.ball.y, BALL_SIZE, BALL_SIZE);
    }
  }

export default function App() {
  const canvasRef = useRef(null);
  const channelRef = useRef(null);
  const rafRef = useRef(null);
  const lastBroadcastRef = useRef(0);
  const lastWinnerRef = useRef(null); // tracks last value pushed to React state
  const keysRef = useRef({ up: false, down: false });
  const stateRef = useRef(makeInitialState());

  const [{ roomCode, isHost }] = useState(resolveRoom);
  const [status, setStatus] = useState('connecting'); // connecting | waiting | connected
  const [winner, setWinner] = useState(null); // null | 'p1' | 'p2' — mirrors stateRef.gameOver for rendering

  // --- Join channel + presence ---
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

      s.opponentPaddleY = payload.paddleY;
      s.remote.paddle.prevY = s.remote.paddle.targetY;
      s.remote.paddle.targetY = payload.paddleY;
      s.remote.paddle.receivedAt = now;

      s.remote.ball.prev = s.remote.ball.target;
      s.remote.ball.target = payload.ball;
      s.remote.ball.receivedAt = now;

      s.score = payload.score;
      s.serving = payload.serving;
      s.gameOver = payload.gameOver;
    });

    channel.on('broadcast', { event: 'p2_state' }, ({ payload }) => {
      if (!isHost) return;
      const s = stateRef.current;
      const now = performance.now();

      s.opponentPaddleY = payload.paddleY;
      s.remote.paddle.prevY = s.remote.paddle.targetY;
      s.remote.paddle.targetY = payload.paddleY;
      s.remote.paddle.receivedAt = now;
    });

    // Either player can request a restart; only the host actually
    // performs it (host is the single source of truth for score/state).
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
      }
    });

    channel.subscribe((subStatus) => {
      if (subStatus === 'SUBSCRIBED') {
        channel.track({ online: true });
      }
    });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomCode, isHost]);

  // --- Keyboard input ---
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

  // --- Game loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const loop = (timestamp) => {
      const s = stateRef.current;

      // Move my own paddle (allowed even after game over, just for fun — harmless)
      if (keysRef.current.up) s.myPaddleY = Math.max(0, s.myPaddleY - PADDLE_SPEED);
      if (keysRef.current.down)
        s.myPaddleY = Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT, s.myPaddleY + PADDLE_SPEED);

      // Host-authoritative physics — frozen once gameOver is set
      if (isHost && s.bothConnected && !s.gameOver) {
        if (s.serving) {
          if (performance.now() >= s.serveAt) s.serving = false;
        } else {
          const ball = s.ball;
          ball.x += ball.vx;
          ball.y += ball.vy;

          if (ball.y <= 0 || ball.y >= CANVAS_HEIGHT - BALL_SIZE) ball.vy *= -1;

          // Left paddle (host / P1)
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
          }

          // Right paddle (opponent / P2)
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
          }

          // Scoring + win check
          if (ball.x < 0) {
            s.score.p2 += 1;
            if (s.score.p2 >= WIN_SCORE) {
              s.gameOver = 'p2';
            } else {
              serveBall(s, 'p2');
            }
          } else if (ball.x > CANVAS_WIDTH - BALL_SIZE) {
            s.score.p1 += 1;
            if (s.score.p1 >= WIN_SCORE) {
              s.gameOver = 'p1';
            } else {
              serveBall(s, 'p1');
            }
          }
        }
      }

      // Push gameOver into React state only when it actually changes,
      // so we re-render the overlay without re-rendering every frame.
      if (s.gameOver !== lastWinnerRef.current) {
        lastWinnerRef.current = s.gameOver;
        setWinner(s.gameOver);
      }

      // Interpolate opponent paddle for smooth rendering
      const remote = s.remote;
      const paddleT = Math.min(
        (performance.now() - remote.paddle.receivedAt) / BROADCAST_INTERVAL_MS,
        1
      );
      const renderOpponentPaddleY = lerp(remote.paddle.prevY, remote.paddle.targetY, paddleT);

      // Player 2 interpolates the ball too (host's ball is already authoritative)
      if (!isHost) {
        const ballT = Math.min(
          (performance.now() - remote.ball.receivedAt) / BROADCAST_INTERVAL_MS,
          1
        );
        s.ball = {
          x: lerp(remote.ball.prev.x, remote.ball.target.x, ballT),
          y: lerp(remote.ball.prev.y, remote.ball.target.y, ballT),
          vx: remote.ball.target.vx,
          vy: remote.ball.target.vy,
        };
      }

      // Throttled broadcast at 30fps
      if (timestamp - lastBroadcastRef.current >= BROADCAST_INTERVAL_MS) {
        lastBroadcastRef.current = timestamp;
        const channel = channelRef.current;
        if (channel) {
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
            channel.send({
              type: 'broadcast',
              event: 'p2_state',
              payload: { paddleY: s.myPaddleY },
            });
          }
        }
      }

      draw(ctx, s, isHost, renderOpponentPaddleY);
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
      {status === 'waiting' && isHost && (
        <p>Share this link: {window.location.href}</p>
      )}

      <div style={{ position: 'relative', display: 'inline-block' }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          style={{ background: '#000', border: '1px solid #444' }}
        />

        {winner && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0, 0, 0, 0.75)',
              gap: '16px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '32px' }}>
              {youWon ? 'You Win! 🎉' : 'You Lose'}
            </h2>
            <p style={{ margin: 0, opacity: 0.8 }}>
              {winner === 'p1' ? 'Player 1' : 'Player 2'} reached {WIN_SCORE} points
            </p>
            <button
              onClick={handleRestart}
              style={{
                padding: '10px 24px',
                fontSize: '16px',
                cursor: 'pointer',
                background: '#fff',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
              }}
            >
              Restart Game
            </button>
          </div>
        )}
      </div>
    </div>
  );
}