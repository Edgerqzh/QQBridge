export function fixtureWav() {
  const h=Buffer.alloc(44),pcm=Buffer.alloc(4800);
  for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(Math.round(Math.sin(i/2*2*Math.PI*440/24000)*5000),i);
  h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(24000,24);h.writeUInt32LE(48000,28);
  h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h,pcm]);
}
