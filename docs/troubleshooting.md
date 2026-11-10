# Troubleshooting

Credentials, recovery after a failed start, and where the logs are.

2026-11-09 的一次启动失败，根因在凭据文件：`~/.dsh/.credentials.yaml` 的 `records` 下出现了重复的 `rss-miniflux` key，credentials 服务启动即报 `DUPLICATE_KEY`，`connection / authorization / deepseek-account` 全部依赖它，整个 Host 起不来。

**现在的约束（不要再犯）**

- 凭据 key 只用 `<scope>/<id>` 语法，**不要用冒号**：`rss-miniflux/accounts`、`rss-miniflux/acct-<id>`。
- 所有凭据写入走插件内的一条串行队列，不并发 `modifyRecord`。
- 旧单账号记录的迁移是 single-flight，一个进程只跑一次；迁移成功后删除旧记录。
- 读取路径不再反复写凭据；账号索引在内存缓存，只有账号操作才失效。

**故障症状**

- DSH 启动后窗口打不开或立即退出；`~/Library/Logs/DeepSeek Harness/crash-*-host.log` 里出现 `credentials-local: invalid document ... DUPLICATE_KEY`。
- 修复工具会先备份再注释掉重复块，保留内容供手工取用。

**恢复步骤**

```bash
cd ~/Documents/Workspace/miniflux-deepread
node scripts/repair-credentials.mjs --check     # 只报告重复 key
node scripts/repair-credentials.mjs             # 备份 + 注释重复块
# 重启 DeepSeek Harness
node scripts/restore-account.mjs --dry-run      # 从注释块找回 Miniflux 账号（不打印 token）
node scripts/restore-account.mjs                # 通过插件 API 重新加入账号
```

`repair-credentials.mjs` 只处理 `records:` 下的重复 key，不动 `refs:`；两个脚本都不打印密钥内容。
