interface IconProps {
  size?: number;
}

const S = (props: IconProps) => props.size ?? 18;

export const IconLabel = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8l9-5 9 5v0l-9 5-9-5z" transform="translate(0,4)" />
    <path d="M7 6h10" />
    <path d="M9 2h6" />
  </svg>
);

export const IconPlace = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);

export const IconMusic = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
);

export const IconMusicOff = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18V5l12-2v13" opacity="0.5" />
    <circle cx="6" cy="18" r="3" opacity="0.5" />
    <circle cx="18" cy="16" r="3" opacity="0.5" />
    <path d="M3 3l18 18" />
  </svg>
);

export const IconInspect = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5.5 5.5" />
    <path d="M8 10.5h5M10.5 8v5" opacity="0.55" />
  </svg>
);

export const IconOrbits = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="6" opacity="0.6" />
    <circle cx="12" cy="12" r="9.5" opacity="0.6" />
    <circle cx="17.2" cy="9" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IconGlobe = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
  </svg>
);

export const IconCenter = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.5v4.2M12 17.3v4.2M2.5 12h4.2M17.3 12h4.2" />
  </svg>
);

export const IconTrackball = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="8.2" />
    <path d="M4.6 10.2c2.4 1.4 5 2.1 7.4 2.1s5-.7 7.4-2.1" opacity="0.75" />
    <path d="M12 3.8c-2.2 2.4-3.4 5.2-3.4 8.2S9.8 17.8 12 20.2" opacity="0.75" />
    <path d="M8.2 4.8 5.4 6.2 6.6 3.2" />
    <path d="M15.8 19.2 18.6 17.8 17.4 20.8" />
  </svg>
);
