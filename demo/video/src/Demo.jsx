import { AbsoluteFill, Easing, Freeze, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { BEATS, cropFor, FPS, planBeat } from './beats.js';

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

// The capture is 1920x1080; shown at 94% in a window that nearly fills the canvas, with the
// caption over its lower third.
const CONTENT_W = 1808;
const CONTENT_H = 1017;
const TITLE_BAR = 36;
const WINDOW_TOP = Math.round((1080 - CONTENT_H - TITLE_BAR) / 2);
const K = CONTENT_W / 1920; // capture pixels to window pixels
const CAPTION_BOTTOM = 84;

const FADE = 8; // highlight fade, about 250 ms
const EASE_IN = 9; // crop ease-in and caption fade, 300 ms
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

  // A highlight fades in, and fades out unless it cropped: a crop cuts straight back.
  const highlight = (beat.highlights ?? []).find(
    (h) => frame >= h.from * FPS && frame < h.to * FPS + (h.crop ? 0 : FADE),
  );
  let crop = { scale: 1, tx: 0, ty: 0 };
  let opacity = 0;
  let rect;
  if (highlight) {
    const start = highlight.from * FPS;
    const end = highlight.to * FPS;
    rect = highlight.rect.map((v) => v * K);
    opacity = interpolate(frame, [start, start + FADE, end, end + FADE], [0, 1, 1, 0], clamp);
    if (highlight.crop) {
      const target = cropFor(rect, CONTENT_W, CONTENT_H);
      const p = interpolate(frame, [start, start + EASE_IN], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
      crop = { scale: 1 + (target.scale - 1) * p, tx: target.tx * p, ty: target.ty * p };
    }
  }

  return (
    <AbsoluteFill>
      <Window>
        <AbsoluteFill style={{ transform: `translate(${crop.tx}px, ${crop.ty}px) scale(${crop.scale})`, transformOrigin: '0 0' }}>
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
          {rect && <Highlight rect={rect} opacity={opacity} scale={crop.scale} />}
        </AbsoluteFill>
        {current && current.speed > 1 && frame < current.at + current.frames && <SpeedBadge speed={current.speed} />}
      </Window>
      <Caption text={beat.caption} total={total} top={(beat.highlights ?? []).some(underCaption)} />
    </AbsoluteFill>
  );
};

// Whether an uncropped highlight would reach into the caption's place at the bottom, so the
// caption should sit at the top for that beat instead.
const underCaption = (h) => !h.crop && WINDOW_TOP + TITLE_BAR + (h.rect[1] + h.rect[3]) * K > 1080 - CAPTION_BOTTOM - 90;

// A violet outline with a soft glow; its huge spread shadow dims everything else to 70%. It sits
// inside the cropped layer, so its sizes are divided by the crop scale to stay constant on screen.
const Highlight = ({ rect: [x, y, w, h], opacity, scale }) => {
  const pad = 6 / scale;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - pad,
        top: y - pad,
        width: w + 2 * pad,
        height: h + 2 * pad,
        borderRadius: 8 / scale,
        border: `${2 / scale}px solid ${ACCENT}`,
        boxShadow: `0 0 ${18 / scale}px ${2 / scale}px rgb(167 139 250 / 0.55), 0 0 0 4000px rgb(0 0 0 / 0.3)`,
        opacity,
      }}
    />
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

// Shown for the whole beat; fading out at its end and in at the next beat's start makes the
// crossfade between sections.
const Caption = ({ text, total, top }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, EASE_IN, total - EASE_IN, total], [0, 1, 1, 0], clamp);
  const place = top ? { top: WINDOW_TOP + TITLE_BAR + 72 } : { bottom: CAPTION_BOTTOM };
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, ...place, display: 'flex', justifyContent: 'center', opacity }}>
      <div
        style={{
          padding: '14px 30px',
          borderRadius: 12,
          background: 'rgb(15 14 20 / 0.88)',
          border: `1px solid ${LINE}`,
          boxShadow: '0 12px 40px rgb(0 0 0 / 0.5)',
          fontSize: 36,
          fontWeight: 500,
        }}
      >
        {text}
      </div>
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
