// Project-owned Node-API 8 Windows boundary. Resolve descriptors inside Node's
// libuv/CRT, never through this DLL's separate CRT descriptor table.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <node_api.h>
#include <stdint.h>
#include <limits.h>

typedef HANDLE (__cdecl *get_osfhandle_fn)(int);
typedef int (__cdecl *open_osfhandle_fn)(HANDLE);
static get_osfhandle_fn node_get_osfhandle;
static open_osfhandle_fn node_open_osfhandle;
static napi_value failure(napi_env env, const char *code, const char *message) {
    napi_throw_error(env, code, message); return NULL;
}
static HANDLE checked_handle(napi_env env, napi_callback_info info) {
    size_t argc=1; napi_value args[1]; double number; napi_valuetype type;
    if(napi_get_cb_info(env,info,&argc,args,NULL,NULL)!=napi_ok || argc!=1 ||
       napi_typeof(env,args[0],&type)!=napi_ok || type!=napi_number ||
       napi_get_value_double(env,args[0],&number)!=napi_ok || number!=number ||
       number<0 || number>INT_MAX || number!=(double)(int)number) {
        napi_throw_type_error(env,NULL,"Invalid file descriptor"); return INVALID_HANDLE_VALUE;
    }
    HANDLE handle=node_get_osfhandle((int)number);
    if(handle==INVALID_HANDLE_VALUE || handle==NULL) {failure(env,"EBADF","Invalid or closed file descriptor");return INVALID_HANDLE_VALUE;}
    if(GetFileType(handle)!=FILE_TYPE_DISK) {failure(env,"FD_TYPE","Descriptor does not refer to a filesystem object");return INVALID_HANDLE_VALUE;}
    return handle;
}
static napi_value descriptor_path(napi_env env, napi_callback_info info) {
    HANDLE handle=checked_handle(env,info);if(handle==INVALID_HANDLE_VALUE)return NULL;
    DWORD length=GetFinalPathNameByHandleW(handle,NULL,0,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
    if(!length || length>32768) return failure(env,"FD_PATH","Unable to obtain the opened object's final path");
    WCHAR *buffer=HeapAlloc(GetProcessHeap(),0,(length+1)*sizeof(WCHAR));
    if(!buffer) return failure(env,"ENOMEM","Unable to allocate path buffer");
    DWORD written=GetFinalPathNameByHandleW(handle,buffer,length+1,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
    napi_value result=NULL;
    if(!written || written>length) failure(env,"FD_PATH","Opened object path changed or could not be resolved");
    else if(napi_create_string_utf16(env,(const char16_t *)buffer,written,&result)!=napi_ok) result=NULL;
    HeapFree(GetProcessHeap(),0,buffer); return result;
}
static WCHAR *get_path(napi_env env,napi_value value) {
    napi_valuetype type; size_t length=0,actual=0;
    if(napi_typeof(env,value,&type)!=napi_ok || type!=napi_string ||
       napi_get_value_string_utf16(env,value,NULL,0,&length)!=napi_ok || !length || length>32767) return NULL;
    WCHAR *text=HeapAlloc(GetProcessHeap(),0,(length+1)*sizeof(WCHAR));
    if(!text) return NULL;
    if(napi_get_value_string_utf16(env,value,(char16_t *)text,length+1,&actual)!=napi_ok || actual!=length) {HeapFree(GetProcessHeap(),0,text);return NULL;}
    for(size_t i=0;i<length;i++)if(!text[i]){HeapFree(GetProcessHeap(),0,text);return NULL;}
    return text;
}
static napi_value descriptor_identity(napi_env env,napi_callback_info info) {
    HANDLE handle=checked_handle(env,info);if(handle==INVALID_HANDLE_VALUE)return NULL;
    FILE_ID_INFO id;
    if(!GetFileInformationByHandleEx(handle,FileIdInfo,&id,sizeof(id)))return failure(env,"FD_ID","Unable to obtain full filesystem identity");
    static const char digits[]="0123456789abcdef";char text[49];
    for(unsigned i=0;i<24;i++){unsigned char v=i<8?(unsigned char)(id.VolumeSerialNumber>>(i*8)):id.FileId.Identifier[i-8];text[i*2]=digits[v>>4];text[i*2+1]=digits[v&15];}
    text[48]=0;napi_value result;napi_create_string_utf8(env,text,48,&result);return result;
}
static napi_value open_read(napi_env env,napi_callback_info info) {
    size_t argc=1;napi_value args[1];
    if(napi_get_cb_info(env,info,&argc,args,NULL,NULL)!=napi_ok || argc!=1)return failure(env,"EINVAL","One path is required");
    WCHAR *filename=get_path(env,args[0]);if(!filename)return failure(env,"EINVAL","Invalid path");
    HANDLE handle=CreateFileW(filename,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,NULL);
    DWORD error=GetLastError();HeapFree(GetProcessHeap(),0,filename);
    if(handle==INVALID_HANDLE_VALUE)return failure(env,(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND)?"ENOENT":"EACCES","Unable to open filesystem object");
    FILE_ATTRIBUTE_TAG_INFO attributes;
    if(!GetFileInformationByHandleEx(handle,FileAttributeTagInfo,&attributes,sizeof(attributes)) || attributes.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT || GetFileType(handle)!=FILE_TYPE_DISK){CloseHandle(handle);return failure(env,"ELOOP","Final reparse points and devices are not permitted");}
    int fd=node_open_osfhandle(handle);
    if(fd<0){CloseHandle(handle);return failure(env,"EMFILE","Unable to allocate Node file descriptor");}
    napi_value result;napi_create_int32(env,fd,&result);return result;
}
static PSECURITY_DESCRIPTOR private_descriptor(BOOL directory) {
    HANDLE token=NULL;DWORD size=0;PTOKEN_USER user=NULL;LPWSTR sid=NULL;PSECURITY_DESCRIPTOR sd=NULL;
    if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return NULL;
    GetTokenInformation(token,TokenUser,NULL,0,&size);
    if(!size || size>65536){CloseHandle(token);return NULL;}
    user=HeapAlloc(GetProcessHeap(),0,size);
    if(user && GetTokenInformation(token,TokenUser,user,size,&size) && ConvertSidToStringSidW(user->User.Sid,&sid)) {
        WCHAR text[512];
        lstrcpyW(text,directory?L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;":L"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;");
        if(lstrlenW(sid)<184){lstrcatW(text,sid);lstrcatW(text,L")");ConvertStringSecurityDescriptorToSecurityDescriptorW(text,SDDL_REVISION_1,&sd,NULL);}
    }
    if(sid)LocalFree(sid);if(user)HeapFree(GetProcessHeap(),0,user);CloseHandle(token);return sd;
}
static napi_value open_private(napi_env env,napi_callback_info info) {
    size_t argc=1;napi_value args[1];
    if(napi_get_cb_info(env,info,&argc,args,NULL,NULL)!=napi_ok || argc!=1)return failure(env,"EINVAL","One path is required");
    WCHAR *filename=get_path(env,args[0]);PSECURITY_DESCRIPTOR sd=private_descriptor(FALSE);
    if(!filename || !sd){if(filename)HeapFree(GetProcessHeap(),0,filename);if(sd)LocalFree(sd);return failure(env,"EACCES","Unable to prepare private file permissions");}
    SECURITY_ATTRIBUTES attributes={sizeof(SECURITY_ATTRIBUTES),sd,FALSE};
    HANDLE handle=CreateFileW(filename,GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,&attributes,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
    DWORD error=GetLastError();HeapFree(GetProcessHeap(),0,filename);LocalFree(sd);
    if(handle==INVALID_HANDLE_VALUE)return failure(env,(error==ERROR_FILE_EXISTS||error==ERROR_ALREADY_EXISTS)?"EEXIST":"EACCES","Unable to create private file");
    int fd=node_open_osfhandle(handle);if(fd<0){CloseHandle(handle);return failure(env,"EMFILE","Unable to allocate Node file descriptor");}
    napi_value result;napi_create_int32(env,fd,&result);return result;
}
static napi_value secure_private(napi_env env,napi_callback_info info) {
    size_t argc=1;napi_value args[1];
    if(napi_get_cb_info(env,info,&argc,args,NULL,NULL)!=napi_ok || argc!=1)return failure(env,"EINVAL","One path is required");
    WCHAR *filename=get_path(env,args[0]);if(!filename)return failure(env,"EINVAL","Invalid path");
    DWORD attributes=GetFileAttributesW(filename);
    PSECURITY_DESCRIPTOR sd=attributes==INVALID_FILE_ATTRIBUTES?NULL:private_descriptor((attributes&FILE_ATTRIBUTE_DIRECTORY)!=0);
    PACL acl=NULL;BOOL present=FALSE,defaulted=FALSE;
    BOOL ok=sd && GetSecurityDescriptorDacl(sd,&present,&acl,&defaulted) && present &&
        SetNamedSecurityInfoW(filename,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,NULL,NULL,acl,NULL)==ERROR_SUCCESS;
    HeapFree(GetProcessHeap(),0,filename);if(sd)LocalFree(sd);
    if(!ok)return failure(env,"EACCES","Unable to apply private filesystem permissions");
    napi_value result;napi_get_undefined(env,&result);return result;
}
static napi_value replace_file(napi_env env,napi_callback_info info) {
    size_t argc=2;napi_value args[2];
    if(napi_get_cb_info(env,info,&argc,args,NULL,NULL)!=napi_ok || argc!=2) return failure(env,"EINVAL","Two paths are required");
    WCHAR *source=get_path(env,args[0]),*target=get_path(env,args[1]);
    if(!source || !target){if(source)HeapFree(GetProcessHeap(),0,source);if(target)HeapFree(GetProcessHeap(),0,target);return failure(env,"EINVAL","Invalid replacement paths");}
    // No COPY_ALLOWED: replacement must stay on the same filesystem.
    BOOL ok=MoveFileExW(source,target,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
    DWORD error=GetLastError();
    HeapFree(GetProcessHeap(),0,source);HeapFree(GetProcessHeap(),0,target);
    if(!ok){napi_value message,code,result,number;napi_create_string_utf8(env,"Durable file replacement failed",NAPI_AUTO_LENGTH,&message);napi_create_string_utf8(env,"FILE_REPLACE",NAPI_AUTO_LENGTH,&code);napi_create_error(env,code,message,&result);napi_create_uint32(env,error,&number);napi_set_named_property(env,result,"win32Code",number);napi_throw(env,result);return NULL;}
    napi_value result;napi_get_undefined(env,&result);return result;
}
BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
    (void)module; (void)reason; (void)reserved; return TRUE;
}
NAPI_MODULE_INIT() {
    node_get_osfhandle=(get_osfhandle_fn)(void *)GetProcAddress(GetModuleHandleW(NULL),"uv_get_osfhandle");
    node_open_osfhandle=(open_osfhandle_fn)(void *)GetProcAddress(GetModuleHandleW(NULL),"uv_open_osfhandle");
    if(!node_get_osfhandle || !node_open_osfhandle)return failure(env,"FD_BACKEND","Node does not export the required libuv descriptor API");
    napi_property_descriptor properties[]={
        {"descriptorPath",NULL,descriptor_path,NULL,NULL,NULL,napi_default,NULL},
        {"descriptorIdentity",NULL,descriptor_identity,NULL,NULL,NULL,napi_default,NULL},
        {"openRead",NULL,open_read,NULL,NULL,NULL,napi_default,NULL},
        {"openPrivate",NULL,open_private,NULL,NULL,NULL,napi_default,NULL},
        {"securePrivate",NULL,secure_private,NULL,NULL,NULL,napi_default,NULL},
        {"replaceFile",NULL,replace_file,NULL,NULL,NULL,napi_default,NULL}
    };
    if(napi_define_properties(env,exports,6,properties)!=napi_ok)return NULL;
    return exports;
}
