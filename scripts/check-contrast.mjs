function linear(v) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function rgb(L, C, h) {
  h *= Math.PI / 180;
  const a = C * Math.cos(h),
    b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return channels.map((v) =>
    Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)),
  );
}
const ratio = (a, b) => {
  const x = luminance(rgb(...a)),
    y = luminance(rgb(...b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const bg = [0.19, 0.006, 80],
  ink = [0.96, 0.006, 80],
  muted = [0.75, 0.008, 80],
  yellow = [0.88, 0.18, 95],
  buttonInk = [0.18, 0.007, 80];
const result = {
  body: ratio(ink, bg),
  muted: ratio(muted, bg),
  accentButton: ratio(yellow, buttonInk),
};
console.log(JSON.stringify(result, null, 2));
if (Object.values(result).some((v) => v < 4.5)) process.exitCode = 1;
