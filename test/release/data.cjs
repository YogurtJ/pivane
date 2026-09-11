// Offline synthetic media fixtures. Run only after the rehearsal server has stopped.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root=process.env.PI_RELEASE_BASE_DIR || '/home/node/pi-workspace';
require('./guard.cjs').rehearsalRoot(root);
assert.equal(fs.readFileSync(path.join(root,'projects/demo/release-marker.txt'),'utf8'),'pi-release-rehearsal-v1\n');
const media=path.join(root,'data/media');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const wav=Buffer.alloc(44+4800); wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4800,40);
const entries=[['generation_history.json','images','png','imageUrl',png],['tts_history.json','audio','wav','audioUrl',wav],['video_history.json','videos','mp4','videoUrl',fs.readFileSync(process.env.PI_RELEASE_VIDEO_FILE || path.join(require('node:os').tmpdir(), 'rehearsal-video.mp4'))]];
for(const [history,dir,ext,key,bytes] of entries){
 const file=`rehearsal.${ext}`;fs.mkdirSync(path.join(media,'public',dir),{recursive:true});
 fs.writeFileSync(path.join(media,'public',dir,file),bytes,{flag:'wx'});
 fs.writeFileSync(path.join(media,history),JSON.stringify([{id:`release-${dir}`,filename:file,[key]:`/${dir}/${file}`,prompt:'Synthetic recovery fixture',text:'Synthetic recovery fixture',createdAt:'2026-09-10T00:00:00Z'}]),{flag:'wx'});
}
fs.writeFileSync(path.join(media,'prompts.json'),JSON.stringify([{id:'rehearsal',title:'Recovery fixture',prompt:'Synthetic saved prompt'}]),{flag:'wx'});
console.log('Synthetic media: image, video, audio and saved prompt written');
