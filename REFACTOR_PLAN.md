# 虫族（Zuzu）重构实施方案

## 项目概述

将 **Quoroom** 项目重命名为 **虫族（Zuzu）**，并将UI界面改为中文，同时重构文件存储系统，使每个房间的数据存储在独立的文件夹中。

## 一、品牌名称更新

### 1.1 数据目录重命名

**当前**: `~/.quoroom-dev/`
**修改为**: `~/.虫族/`

**需要修改的文件**:
```bash
src/cli/index.ts              # USER_APP_DIR 定义
src/server/index.ts           # QUOROOM_DATA_DIR
src/shared/constants.ts       # 常量定义
scripts/dev-server.js         # 开发服务器
scripts/build-*.js            # 构建脚本
```

### 1.2 品牌名称全局替换

**替换规则**:
- `Quoroom` → `虫族` (UI显示)
- `quoroom` → `zuzu` (代码引用)
- `QUOROOM` → `ZUZU` (常量)

**批量替换命令**:
```bash
# macOS
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) -exec sed -i '' 's/Quoroom/虫族/g' {} \;
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) -exec sed -i '' 's/quoroom/zuzu/g' {} \;

# Linux
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) -exec sed -i 's/Quoroom/虫族/g' {} \;
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) -exec sed -i 's/quoroom/zuzu/g' {} \;
```

## 二、UI界面中文化

### 2.1 主要界面组件翻译

| 组件 | 当前英文 | 中文翻译 |
|------|---------|---------|
| Dashboard | Dashboard | 控制面板 |
| Rooms | Rooms | 房间 |
| Goals | Goals | 目标 |
| Skills | Skills | 技能 |
| Memory | Memory | 记忆 |
| Wallet | Wallet | 钱包 |
| Settings | Settings | 设置 |
| Swarm | Swarm | 虫群 |
| Clerk | Clerk | 书记官 |

### 2.2 按钮和操作翻译

| 英文 | 中文 |
|------|------|
| Create Room | 创建房间 |
| Start | 启动 |
| Stop | 停止 |
| Pause | 暂停 |
| Delete | 删除 |
| Edit | 编辑 |
| Save | 保存 |
| Cancel | 取消 |
| Confirm | 确认 |

### 2.3 状态和提示翻译

| 英文 | 中文 |
|------|------|
| Active | 活跃 |
| Paused | 已暂停 |
| Stopped | 已停止 |
| Loading... | 加载中... |
| Error | 错误 |
| Success | 成功 |

## 三、房间文件系统架构

### 3.1 目录结构设计

```
~/.虫族/
├── rooms/                          # 房间根目录
│   ├── {roomId}/                   # 每个房间一个文件夹
│   │   ├── room.json              # 房间元数据
│   │   ├── skills/                # 技能文件
│   │   │   ├── {skillId}.md
│   │   │   └── .index.json        # 技能索引
│   │   ├── goals/                 # 目标文件
│   │   │   ├── {goalId}.json
│   │   │   └── .index.json        # 目标索引
│   │   ├── memory/                # 记忆数据
│   │   │   ├── entities.json
│   │   │   ├── observations.json
│   │   │   └── relations.json
│   │   ├── workers/               # Worker 配置
│   │   │   ├── {workerId}.json
│   │   │   └── .index.json
│   │   ├── tasks/                 # 任务数据
│   │   │   ├── {taskId}.json
│   │   │   └── .index.json
│   │   ├── logs/                  # 日志文件
│   │   │   ├── cycle-{date}.log
│   │   │   └── console-{date}.log
│   │   └── self-mod/              # 自我修改审计
│   │       ├── audit-{auditId}.json
│   │       └── snapshot-{id}.json
│   └── .room-index.json           # 全局房间索引
├── global.db                      # 全局数据库
│                               # 存储: 用户、认证、全局设置
├── config.json                   # 全局配置
├── api.token                      # API 认证令牌
├── api.port                       # 端口配置
└── cache/                         # 缓存目录
    ├── embeddings/                # 向量缓存
    └── web-cache/                # 网页缓存
```

### 3.2 文件格式规范

#### room.json (房间元数据)
```json
{
  "id": 1,
  "name": "测试房间",
  "goal": "测试目标",
  "status": "active",
  "createdAt": "2026-03-03T18:00:00.000Z",
  "updatedAt": "2026-03-03T18:00:00.000Z"
}
```

#### skills/{skillId}.md
```markdown
# 技能名称

技能内容（Markdown格式）

## 创建时间
2026-03-03T18:00:00.000Z

## 版本
3

## 创建者
Worker ID: 5
```

#### goals/{goalId}.json
```json
{
  "id": 1,
  "name": "主要目标",
  "status": "active",
  "parentId": null,
  "workerId": 3,
  "createdAt": "2026-03-03T18:00:00.000Z"
}
```

### 3.3 存储层抽象设计

#### 文件系统存储接口

```typescript
// src/shared/fs-storage.ts

interface RoomStorage {
  // 技能管理
  createSkill(roomId: number, skill: Skill): Promise<void>
  getSkill(roomId: number, skillId: number): Promise<Skill | null>
  updateSkill(roomId: number, skillId: number, updates: Partial<Skill>): Promise<void>
  deleteSkill(roomId: number, skillId: number): Promise<void>
  listSkills(roomId: number): Promise<Skill[]>

  // 目标管理
  createGoal(roomId: number, goal: Goal): Promise<void>
  getGoal(roomId: number, goalId: number): Promise<Goal | null>
  updateGoal(roomId: number, goalId: number, updates: Partial<Goal>): Promise<void>
  deleteGoal(roomId: number, goalId: number): Promise<void>
  listGoals(roomId: number): Promise<Goal[]>

  // 记忆管理
  saveMemory(roomId: number, type: 'entities'|'observations'|'relations', data: unknown): Promise<void>
  loadMemory(roomId: number, type: string): Promise<unknown>

  // Worker 管理
  saveWorkerConfig(roomId: number, workerId: number, config: unknown): Promise<void>
  loadWorkerConfig(roomId: number, workerId: number): Promise<unknown>

  // 日志管理
  appendLog(roomId: number, type: 'cycle'|'console', content: string): Promise<void>

  // 自我修改审计
  saveAuditLog(roomId: number, audit: SelfModAudit): Promise<void>
  saveSnapshot(roomId: number, snapshot: SelfModSnapshot): Promise<void>
}

class FileSystemRoomStorage implements RoomStorage {
  private basePath: string

  constructor() {
    this.basePath = path.join(homedir(), '.虫族', 'rooms')
  }

  getRoomPath(roomId: number): string {
    return path.join(this.basePath, roomId.toString())
  }

  async createSkill(roomId: number, skill: Skill): Promise<void> {
    const roomPath = this.getRoomPath(roomId)
    const skillPath = path.join(roomPath, 'skills', `${skill.id}.md`)

    await fs.mkdir(path.dirname(skillPath), { recursive: true })
    await fs.writeFile(skillPath, this.formatSkill(skill), 'utf-8')
    await this.updateIndex(roomPath, 'skills', skill.id, skill)
  }

  // ... 其他方法实现
}
```

### 3.4 数据库职责重新划分

**保留在数据库**:
- 用户认证和授权
- 全局设置
- 跨房间数据（Inbox消息、联系人）
- 性能索引（加速查询）
- 会话数据

**迁移到文件系统**:
- 技能内容（Markdown文件）
- 目标定义（JSON文件）
- 记忆数据（JSON文件）
- Worker配置（JSON文件）
- 日志文件（文本文件）
- 自我修改审计（JSON文件）

**数据库只保留索引**:
```sql
-- skills 表：保留元数据和文件路径
CREATE TABLE skills (
  id INTEGER PRIMARY KEY,
  room_id INTEGER,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,  -- 新增：指向文件路径
  version INTEGER DEFAULT 1,
  created_at DATETIME,
  updated_at DATETIME
);

-- 去掉 content 字段（内容在文件中）
```

## 四、迁移策略

### 4.1 阶段一：数据目录重命名（低风险）

1. 检测现有数据目录
2. 创建新目录 `~/.虫族/`
3. 迁移数据文件（如果存在）
4. 更新所有引用
5. 测试启动

### 4.2 阶段二：UI中文化（中风险）

1. 创建语言文件 `src/ui/i18n/zh-CN.json`
2. 更新组件使用翻译
3. 测试所有界面
4. 回退方案：保留英文作为fallback

### 4.3 阶段三：文件系统重构（高风险）

**实施步骤**:

1. **设计阶段**（1天）
   - 定义文件结构
   - 设计存储抽象接口
   - 编写迁移脚本

2. **实现阶段**（3天）
   - 实现文件系统存储层
   - 修改所有数据访问代码
   - 添加缓存机制

3. **迁移阶段**（1天）
   - 停止服务
   - 执行数据迁移
   - 验证数据完整性
   - 启动服务

4. **测试阶段**（2天）
   - 单元测试
   - 集成测试
   - 性能测试

**迁移脚本设计**:

```typescript
// scripts/migrate-to-fs.ts

async function migrateRoomData(db: Database.Database, roomId: number) {
  // 1. 创建房间目录
  const roomPath = path.join(USER_DATA_DIR, 'rooms', roomId.toString())
  await fs.mkdir(roomPath, { recursive: true })

  // 2. 迁移技能
  const skills = db.prepare('SELECT * FROM skills WHERE room_id = ?').all(roomId)
  await fs.mkdir(path.join(roomPath, 'skills'), { recursive: true })
  for (const skill of skills) {
    await fs.writeFile(
      path.join(roomPath, 'skills', `${skill.id}.md`),
      skill.content,
      'utf-8'
    )
  }

  // 3. 迁移其他数据...

  // 4. 更新数据库索引
  db.prepare('UPDATE skills SET file_path = ? WHERE id = ?').run(
    path.join(roomPath, 'skills', `${skill.id}.md`),
    skill.id
  )
}
```

### 4.4 回滚计划

**迁移前备份**:
```bash
# 备份数据库
cp ~/.虫族/data.db ~/.虫族/data.db.backup-$(date +%Y%m%d)

# 备份整个数据目录
tar -czf ~/zuzu-backup-$(date +%Y%m%d).tar.gz ~/.虫族/
```

**回滚步骤**:
```bash
# 1. 停止服务
npm run kill:dev-runtime

# 2. 恢复数据库
cp ~/.虫族/data.db.backup-YYYYMMDD ~/.虫族/data.db

# 3. 删除新文件系统数据（保留数据库）
rm -rf ~/.虫族/rooms/

# 4. 重启服务
npm run dev:room
```

## 五、风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 数据丢失 | 高 | 低 | 充分备份 + 迁移验证 |
| 性能下降 | 中 | 中 | 文件缓存 + 异步IO |
| 文件系统权限 | 中 | 低 | 权限检查 + 降级处理 |
| 迁移失败 | 高 | 低 | 完整回滚方案 |
| 翻译错误 | 低 | 中 | 保留英文fallback |

## 六、实施时间表

### 第1周：品牌更新 + UI中文化
- Day 1-2: 批量替换品牌名称
- Day 3-4: UI界面翻译
- Day 5: 测试和修复

### 第2周：文件系统架构设计
- Day 1-2: 架构设计和接口定义
- Day 3-4: 存储层实现
- Day 5: 单元测试

### 第3周：迁移和测试
- Day 1-2: 迁移脚本开发
- Day 3: 数据迁移执行
- Day 4-5: 集成测试和性能优化

## 七、成功标准

### 品牌更新
- [ ] 所有界面显示"虫族"而非"Quoroom"
- [ ] 代码中使用"zuzu"引用
- [ ] 文档全部更新

### UI中文化
- [ ] 所有菜单和按钮为中文
- [ ] 所有提示信息为中文
- [ ] 专业术语统一

### 文件系统
- [ ] 每个房间有独立文件夹
- [ ] 数据读写性能与数据库相当
- [ ] 文件结构清晰易于管理
- [ ] 支持手动查看和编辑
- [ ] 完整的备份和恢复机制

## 八、维护建议

### 文件系统维护

1. **定期清理**
```bash
# 清理已删除房间的文件（30天后）
find ~/.虫族/rooms/* -mtime +30 -type d -exec rm -rf {} \;
```

2. **磁盘监控**
```bash
# 检查磁盘使用
du -sh ~/.虫族/rooms/* | sort -h
```

3. **备份策略**
- 每日自动备份数据库
- 每周完整备份文件系统
- 保留最近30天的备份

### 文件编辑指南

用户可以直接编辑房间文件：

```
# 编辑技能
vim ~/.虫族/rooms/1/skills/5.md

# 查看记忆
cat ~/.虫族/rooms/1/memory/entities.json

# 查看日志
tail -f ~/.虫族/rooms/1/logs/cycle-$(date +%Y%m%d).log
```

## 附录

### A. 关键文件清单

需要修改的核心文件：
- `package.json`
- `src/ui/index.html`
- `src/ui/App.tsx`
- `src/shared/constants.ts`
- `src/cli/index.ts`
- `src/server/index.ts`
- 所有UI组件文件

### B. 测试检查清单

- [ ] 数据目录正确创建在 `~/.虫族/`
- [ ] 所有房间有独立文件夹
- [ ] 技能文件正确保存为 .md
- [ ] 目标文件正确保存为 .json
- [ ] 日志文件正常写入
- [ ] 文件编辑后系统可正常读取
- [ ] 性能无明显下降
- [ ] 备份和恢复正常工作

### C. 常见问题

**Q: 数据迁移会丢失吗？**
A: 不会。迁移前会自动备份，且有完整的回滚方案。

**Q: 可以手动编辑文件吗？**
A: 可以。所有文件都是纯文本（JSON/Markdown），可以直接编辑。

**Q: 文件系统会比数据库慢吗？**
A: 有轻微差异，但通过缓存机制，实际使用中差异可忽略。

**Q: 如何备份整个系统？**
A: 直接复制 `~/.虫族/` 文件夹即可。

---

**文档版本**: 1.0
**创建时间**: 2026-03-03
**最后更新**: 2026-03-03
