# Pi 依赖升级

Pivane公开包当前锁定Pi 0.85.0及配套官方包，不维护上游源码补丁。该版本依赖的官方pi-server包由项目明确声明补齐，不启用实验server模式。

当前源码还提供[受管Pi更新](UPDATES.md)：在独立安装快照中同步固定官方配套包版本，执行npm安装与隔离SDK/RPC/原生会话探针，通过后停机备份并切换。它不修改原安装的node_modules，也不等于全局pi update；自动检查的范围有限，第三方扩展与真实供应商仍需核对。原配版本与受管版本在设置中分别显示。

升级时在隔离目录安装目标精确版本，检查SDK/RPC/session格式与原生组件兼容，更新package/lock并跑相应平台回归。已有会话、凭据与媒体数据不能替换为测试数据。停机、备份、回退和发布核对见[发布流程](development/RELEASING.md)与[安装恢复](INSTALL_RECOVERY.md)。
