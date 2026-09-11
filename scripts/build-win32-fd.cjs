// Maintainer-only cross build. Ordinary installation uses the verified prebuilt DLL.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const zig=process.env.PI_WINDOWS_ZIG,headers=process.env.PI_WINDOWS_NODE_HEADERS,library=process.env.PI_WINDOWS_NODE_LIB;
if(!zig||!headers||!library)throw Error('Set PI_WINDOWS_ZIG, PI_WINDOWS_NODE_HEADERS and PI_WINDOWS_NODE_LIB to the verified Zig 0.14.1 and Node 22.23.2 inputs');
const version=execFileSync(zig,['version'],{encoding:'utf8'}).trim();if(version!=='0.14.1')throw Error('Expected Zig 0.14.1');
const digest=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const source=path.join(root,'native/pi-win32-fd.c'),binary=path.join(root,'native/pi-win32-x64-fd.node');
const flags=['cc','-target','x86_64-windows-gnu','-shared','-Os','-s','-DNAPI_VERSION=8','-DBUILDING_NODE_EXTENSION','-nostdlib','-Wl,--entry,DllMain','-lkernel32','-ladvapi32'];
const windowsHeaders=path.join(path.dirname(zig),'lib/libc/include/any-windows-any');
execFileSync(zig,[...flags,'-isystem',windowsHeaders,'-I'+headers,source,library,'-o',binary],{stdio:'inherit'});
const manifest={platform:'win32',arch:'x64',napi:8,nodeHeaders:'22.23.2',compiler:'Zig '+version,compilerSha256:digest(zig),flags,sourceSha256:digest(source),binarySha256:digest(binary),nodeImportLibrarySha256:digest(library),headers:Object.fromEntries(['node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h'].map(n=>[n,digest(path.join(headers,n))]))};
fs.writeFileSync(path.join(root,'native/win32-x64-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest,null,2));
