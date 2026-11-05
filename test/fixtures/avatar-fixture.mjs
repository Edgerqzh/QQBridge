// Deterministic first-frame fixture: one red frame followed by one blue frame.
export const animatedAvatarGif = Buffer.from([
  ...Buffer.from('GIF89a'), 1,0,1,0,128,0,0, 255,0,0, 0,0,255,
  33,249,4,0,10,0,0,0, 44,0,0,0,0,1,0,1,0,0, 2,2,68,1,0,
  33,249,4,0,10,0,0,0, 44,0,0,0,0,1,0,1,0,0, 2,2,76,1,0, 59,
]);
