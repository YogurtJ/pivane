# Pi 依赖升级

Pivane当前锁定Pi 0.85.0及配套官方包，不修改node_modules或维护上游源码补丁。该版本依赖的官方pi-server包由项目明确声明补齐，不启用实验server模式。

升级时在隔离目录安装目标精确版本，检查SDK/RPC/session格式与原生组件兼容，更新package/lock并跑相应平台回归。已有会话、凭据与媒体数据不能替换为测试数据。停机、备份、回退和发布核对见[发布流程](development/RELEASING.md)与[安装恢复](INSTALL_RECOVERY.md)。
