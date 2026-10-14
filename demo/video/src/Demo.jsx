import { AbsoluteFill, Freeze, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { BEATS, FPS, planBeat } from './beats.js';

// Colours from ui/theme.css (dark), plus the brand violet.
const CANVAS = '#0f0e14';
const BG = '#0e1116';
const SURFACE = '#1b212a';
const LINE = '#2a323d';
const FG = '#d8dee6';
const DIM = '#8b96a5';
const ACCENT = '#a78bfa';
const UI_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

// The capture is 1920x1080; shown at 80% in a window, which leaves a band below for captions.
const CONTENT_W = 1536;
const CONTENT_H = 864;
const TITLE_BAR = 36;
const WINDOW_TOP = 36;

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };

export const Demo = ({ clips }) => {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: CANVAS, fontFamily: UI_FONT, color: FG }}>
      {BEATS.map((beat) => {
        const frames = beat.seconds * FPS;
        const scene = (
          <Sequence key={beat.id} from={from} durationInFrames={frames} name={beat.id}>
            {beat.id === 'title' ? <TitleCard /> : beat.id === 'end' ? <EndCard /> : <ClipScene beat={beat} clip={clips[beat.id]} />}
          </Sequence>
        );
        from += frames;
        return scene;
      })}
    </AbsoluteFill>
  );
};

const ClipScene = ({ beat, clip }) => {
  const frame = useCurrentFrame();
  const total = beat.seconds * FPS;
  let at = 0;
  const parts = planBeat(beat, clip.seconds).map((s) => ({ ...s, at: (at += s.frames) - s.frames }));
  const current = parts.findLast((p) => frame >= p.at);
  const scale = beat.zoom ? interpolate(frame, [0, total], [1, 1.15]) : 1;
  return (
    <AbsoluteFill>
      <Window>
        <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: beat.zoom }}>
          {parts.map((p, i) => (
            // The last part runs to the end of the beat, holding its last frame.
            <Sequence key={p.at} from={p.at} durationInFrames={i === parts.length - 1 ? total - p.at : p.frames}>
              <Freeze frame={p.frames - 1} active={(f) => f >= p.frames}>
                <OffthreadVideo
                  src={clip.src}
                  trimBefore={p.trimBefore}
                  playbackRate={p.speed}
                  muted
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </Freeze>
            </Sequence>
          ))}
        </AbsoluteFill>
        {current && current.speed > 1 && frame < current.at + current.frames && <SpeedBadge speed={current.speed} />}
      </Window>
      <Caption text={beat.caption} at={beat.captionAt ?? 0.6} seconds={beat.captionSeconds ?? 4} />
    </AbsoluteFill>
  );
};

const Window = ({ children }) => (
  <div
    style={{
      position: 'absolute',
      left: (1920 - CONTENT_W) / 2,
      top: WINDOW_TOP,
      width: CONTENT_W,
      height: CONTENT_H + TITLE_BAR,
      borderRadius: 12,
      border: `1px solid ${LINE}`,
      overflow: 'hidden',
      background: BG,
      boxShadow: '0 24px 80px rgb(0 0 0 / 0.55)',
    }}
  >
    <div
      style={{
        height: TITLE_BAR,
        background: SURFACE,
        borderBottom: `1px solid ${LINE}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        fontSize: 15,
        color: DIM,
      }}
    >
      <div style={{ position: 'absolute', left: 14, display: 'flex', gap: 8 }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
          <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
        ))}
      </div>
      Tiller
    </div>
    <div style={{ position: 'relative', width: CONTENT_W, height: CONTENT_H, overflow: 'hidden' }}>{children}</div>
  </div>
);

const SpeedBadge = ({ speed }) => (
  <div
    style={{
      position: 'absolute',
      top: 16,
      right: 16,
      padding: '4px 12px',
      borderRadius: 8,
      background: 'rgb(15 14 20 / 0.8)',
      border: `1px solid ${ACCENT}`,
      color: ACCENT,
      font: `600 22px ${MONO}`,
    }}
  >
    x{speed}
  </div>
);

const Caption = ({ text, at, seconds }) => {
  const frame = useCurrentFrame();
  const start = at * FPS;
  const end = start + seconds * FPS;
  const opacity = interpolate(frame, [start, start + 12, end - 12, end], [0, 1, 1, 0], clamp);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: WINDOW_TOP + TITLE_BAR + CONTENT_H,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 36,
        fontWeight: 500,
        opacity,
        transform: `translateY(${(1 - opacity) * 8}px)`,
      }}
    >
      {text}
    </div>
  );
};

const FadeIn = ({ children }) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: interpolate(frame, [0, 15], [0, 1], clamp) }}>{children}</AbsoluteFill>;
};

const centred = { alignItems: 'center', justifyContent: 'center', flexDirection: 'column' };

const TitleCard = () => (
  <FadeIn>
    <AbsoluteFill style={centred}>
      <Img src={staticFile('logo-dark.png')} style={{ width: 440 }} />
      <div style={{ fontSize: 128, fontWeight: 600, letterSpacing: -2, marginTop: 24 }}>tiller</div>
      <div style={{ fontSize: 36, color: DIM, marginTop: 8 }}>a tree of Claude Code agents, with a hand on the tiller</div>
    </AbsoluteFill>
  </FadeIn>
);

const EndCard = () => (
  <FadeIn>
    <AbsoluteFill style={centred}>
      <Img src={staticFile('icon.png')} style={{ width: 220 }} />
      <div style={{ fontSize: 104, fontWeight: 600, letterSpacing: -2, marginTop: 16 }}>tiller</div>
      <div style={{ fontSize: 38, color: ACCENT, fontFamily: MONO, marginTop: 12 }}>github.com/swicken/tiller</div>
      <div style={{ fontSize: 22, color: DIM, marginTop: 48 }}>built with tiller</div>
    </AbsoluteFill>
  </FadeIn>
);

// Stand-in frame for a beat until the real capture lands (see make-placeholders.sh).
export const Placeholder = ({ label }) => (
  <AbsoluteFill style={{ ...centred, background: BG, fontFamily: UI_FONT, color: DIM, border: `2px dashed ${LINE}` }}>
    <div style={{ fontSize: 40 }}>placeholder clip</div>
    <div style={{ fontSize: 120, fontWeight: 600, color: FG, fontFamily: MONO }}>{label}</div>
  </AbsoluteFill>
);
