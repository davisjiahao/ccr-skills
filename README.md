# CCR Skills

Claude Code Router 模型管理技能包，提供便捷的模型切换和状态显示功能。

## 功能特性

- **模型管理**: 列出、查询、切换 CCR 模型
- **模糊匹配**: 支持模型别名 (如 `m2.5` → `MiniMax-M2.5`)
- **状态显示**: 每次工具使用后自动显示当前模型
- **多级配置**: 支持全局、项目、会话三级模型配置

## 配置优先级

CCR 支持三级配置，优先级从高到低：

1. **会话级别** `~/.claude-code-router/<project-id>/<sessionId>.json`
2. **项目级别** `~/.claude-code-router/<project-id>/config.json`
3. **全局配置** `~/.claude-code-router/config.json`

## 安装

### 方式一：一键安装 (推荐)

```bash
curl -fsSL https://raw.githubusercontent.com/xxx/ccr-skills/main/install.sh | bash
```

### 方式二：手动安装

```bash
# 克隆仓库
git clone https://github.com/xxx/ccr-skills.git

# 运行安装脚本
cd ccr-skills && ./install.sh
```

### 方式三：手动配置

1. 复制文件到 Claude skills 目录:
```bash
mkdir -p ~/.claude/skills/ccr-model
cp -r skills/ccr-model/* ~/.claude/skills/ccr-model/
cp -r hooks ~/.claude/skills/ccr-model/
```

2. 在 `~/.claude/settings.json` 中添加 hook 配置:
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/skills/ccr-model/hooks/show-model.js"
          }
        ]
      }
    ]
  }
}
```

## 使用方法

重启 Claude Code 后，可以使用以下命令：

### 基础命令

```
/ccr-model list              # 列出所有模型
/ccr-model set opus          # 设置全局模型 (支持模糊匹配)
/ccr-model status            # 查看状态
/ccr-model import            # 从 cc-switch 导入 providers
```

### 项目/会话级别配置

```
/ccr-model set glm-5 --project    # 设置项目级别模型
/ccr-model set glm-5 --session    # 设置会话级别模型
/ccr-model project                # 查看项目配置
/ccr-model session                # 查看会话配置
```

### 角色配置

```
/ccr-model set m2.5 --role=think      # 只设置 think 角色
/ccr-model set claude --role=longContext  # 只设置长上下文角色
```

## 依赖

- [CCR (Claude Code Router)](https://github.com/xxx/claude-code-router)
- Node.js 18+
- (可选) [cc-switch](https://github.com/xxx/cc-switch) - 用于导入 provider 配置

## 目录结构

**源码结构：**
```
ccr-skills/
├── install.sh           # 安装脚本
├── README.md
├── skills/
│   └── ccr-model/
│       ├── SKILL.md     # 技能描述
│       └── ccr-model.js # 主脚本
└── hooks/
    └── show-model.js    # 显示当前模型的 hook
```

**安装后结构：**
```
~/.claude/skills/ccr-model/
├── SKILL.md
├── ccr-model.js
└── hooks/
    └── show-model.js
```

**CCR 配置目录结构：**
```
~/.claude-code-router/
├── config.json                    # 全局配置
├── <project-id>/                  # 项目配置目录
│   ├── config.json               # 项目级别配置
│   └── <sessionId>.json          # 会话级别配置
└── .claude-code-router.pid        # PID 文件
```

## 卸载

```bash
rm -rf ~/.claude/skills/ccr-model
# 并从 settings.json 中删除对应的 hooks 配置
```

## License

MIT
