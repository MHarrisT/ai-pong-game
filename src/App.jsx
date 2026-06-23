import { useEffect, useRef, useState } from 'react';
import './App.css';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

const PADDLE_WIDTH = 12;
const PADDLE_HEIGHT = 90;
const PADDLE_SPEED = 6;
const PADDLE_MARGIN = 20; // distance from side wall

const BALL_SIZE = 12; // ball is drawn/treated as a square for simpler AABB collision
const BALL_SPEED_START = 5;
const BALL_SPEED_MAX = 14;
const SPEED_INCREMENT = 0.4; // how much the ball speeds up on each paddle hit

function App() {
  const canvasRef = useRef(null);

  // Game objects live in refs so the rAF loop can mutate them directly
  // without fighting React's render cycle.
  const leftPaddleRef = useRef({
    x: PADDLE_MARGIN,
    y: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
  });

  const rightPaddleRef = useRef({
    x: CANVAS_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH,
    y: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
  });

  const ballRef = useRef({
    x: CANVAS_WIDTH / 2 - BALL_SIZE / 2,
    y: CANVAS_HEIGHT / 2 - BALL_SIZE / 2,
    vx: BALL_SPEED_START,
    vy: BALL_SPEED_START * 0.6,
  });

  // Tracks which movement keys are currently held down.
  const keysRef = useRef({
    w: false,
    s: false,
    ArrowUp: false,
    ArrowDown: false,
  });

  const [score, setScore] = useState({ left: 0, right: 0 });
  const scoreRef = useRef(score); // mirror of score for use inside the loop

  useEffect(() => {
    scoreRef.current = score;
  }, [score]);

  // Resets the ball to the center and sends it off in a (slightly) random direction.
  const resetBall = (direction) => {
    const angle = (Math.random() * 0.6 - 0.3); // small random vertical angle
    ballRef.current = {
      x: CANVAS_WIDTH / 2 - BALL_SIZE / 2,
      y: CANVAS_HEIGHT / 2 - BALL_SIZE / 2,
      vx: direction * BALL_SPEED_START,
      vy: BALL_SPEED_START * angle * 2,
    };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const handleKeyDown = (e) => {
      if (e.key in keysRef.current) {
        keysRef.current[e.key] = true;
        e.preventDefault();
      }
    };

    const handleKeyUp = (e) => {
      if (e.key in keysRef.current) {
        keysRef.current[e.key] = false;
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    let animationFrameId;

    const update = () => {
      const keys = keysRef.current;
      const leftPaddle = leftPaddleRef.current;
      const rightPaddle = rightPaddleRef.current;
      const ball = ballRef.current;

      // --- Paddle movement ---
      if (keys.w) leftPaddle.y -= PADDLE_SPEED;
      if (keys.s) leftPaddle.y += PADDLE_SPEED;
      if (keys.ArrowUp) rightPaddle.y -= PADDLE_SPEED;
      if (keys.ArrowDown) rightPaddle.y += PADDLE_SPEED;

      // Clamp paddles inside the canvas
      leftPaddle.y = Math.max(0, Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT, leftPaddle.y));
      rightPaddle.y = Math.max(0, Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT, rightPaddle.y));

      // --- Ball movement ---
      ball.x += ball.vx;
      ball.y += ball.vy;

      // Top / bottom wall collision
      if (ball.y <= 0) {
        ball.y = 0;
        ball.vy *= -1;
      } else if (ball.y + BALL_SIZE >= CANVAS_HEIGHT) {
        ball.y = CANVAS_HEIGHT - BALL_SIZE;
        ball.vy *= -1;
      }

      // Helper for AABB collision between ball and a paddle
      const collidesWithPaddle = (paddle) =>
        ball.x < paddle.x + PADDLE_WIDTH &&
        ball.x + BALL_SIZE > paddle.x &&
        ball.y < paddle.y + PADDLE_HEIGHT &&
        ball.y + BALL_SIZE > paddle.y;

      // Left paddle collision
      if (ball.vx < 0 && collidesWithPaddle(leftPaddle)) {
        ball.x = leftPaddle.x + PADDLE_WIDTH; // prevent sticking
        const speed = Math.min(Math.abs(ball.vx) + SPEED_INCREMENT, BALL_SPEED_MAX);
        ball.vx = speed;

        // Add a bit of vertical English based on where the ball hit the paddle
        const hitPos = (ball.y + BALL_SIZE / 2 - (leftPaddle.y + PADDLE_HEIGHT / 2)) / (PADDLE_HEIGHT / 2);
        ball.vy += hitPos * 2;
      }

      // Right paddle collision
      if (ball.vx > 0 && collidesWithPaddle(rightPaddle)) {
        ball.x = rightPaddle.x - BALL_SIZE; // prevent sticking
        const speed = Math.min(Math.abs(ball.vx) + SPEED_INCREMENT, BALL_SPEED_MAX);
        ball.vx = -speed;

        const hitPos = (ball.y + BALL_SIZE / 2 - (rightPaddle.y + PADDLE_HEIGHT / 2)) / (PADDLE_HEIGHT / 2);
        ball.vy += hitPos * 2;
      }

      // Scoring: ball goes past a paddle off the left or right edge
      if (ball.x + BALL_SIZE < 0) {
        setScore((prev) => ({ ...prev, right: prev.right + 1 }));
        resetBall(1);
      } else if (ball.x > CANVAS_WIDTH) {
        setScore((prev) => ({ ...prev, left: prev.left + 1 }));
        resetBall(-1);
      }

      draw();
      animationFrameId = requestAnimationFrame(update);
    };

    const draw = () => {
      const leftPaddle = leftPaddleRef.current;
      const rightPaddle = rightPaddleRef.current;
      const ball = ballRef.current;

      // Background
      ctx.fillStyle = '#0b0b0f';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Center dotted line
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 12]);
      ctx.beginPath();
      ctx.moveTo(CANVAS_WIDTH / 2, 0);
      ctx.lineTo(CANVAS_WIDTH / 2, CANVAS_HEIGHT);
      ctx.stroke();
      ctx.setLineDash([]); // reset dash for other shapes

      // Paddles
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(leftPaddle.x, leftPaddle.y, PADDLE_WIDTH, PADDLE_HEIGHT);
      ctx.fillRect(rightPaddle.x, rightPaddle.y, PADDLE_WIDTH, PADDLE_HEIGHT);

      // Ball
      ctx.fillRect(ball.x, ball.y, BALL_SIZE, BALL_SIZE);

      // Score
      ctx.font = 'bold 48px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(scoreRef.current.left), CANVAS_WIDTH / 2 - 80, 60);
      ctx.fillText(String(scoreRef.current.right), CANVAS_WIDTH / 2 + 80, 60);
    };

    animationFrameId = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        backgroundColor: '#111',
        gap: '16px',
      }}
    >
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        style={{ border: '2px solid #444', backgroundColor: '#0b0b0f' }}
      />
      <p style={{ color: '#aaa', fontFamily: 'monospace', fontSize: '14px' }}>
        Player 1: W / S &nbsp;&nbsp;|&nbsp;&nbsp; Player 2: ArrowUp / ArrowDown
      </p>
    </div>
  );
}

export default App;