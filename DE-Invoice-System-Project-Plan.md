# 德国发票会计系统 - 项目规划书

**版本**: 1.1  
**创建日期**: 2026-05-21  
**更新日期**: 2026-05-22  
**状态**: 初稿  
**语言**: 中文（德语区适用）

---

## 一、项目概述

### 1.1 项目背景与目标

开发一款面向德国市场（含欧盟范围）的专业发票与会计管理Web应用。该系统需要满足德国政府对电子发票和会计记录保存的严格要求（GoBD/GDPdU），同时提供完整的会计功能，帮助中小企业实现数字化转型。

**核心目标**：
- 生成符合德国法律要求的电子发票
- 支持欧盟VAT体系（包括反向征收机制）
- 提供完整的会计核算功能
- 实现云端与本地双重数据存储
- 确保数据安全与合规性

### 1.2 目标用户

| 用户群体 | 需求特点 |
|---------|---------|
| 德国中小企业主 | 简化会计流程，降低成本，符合法规 |
| 自由职业者 | 快速生成专业发票，移动端友好 |
| 会计事务所 | 多客户管理，批量操作，高效对账 |
| 跨境电商 | 欧盟多国VAT处理，进出口发票 |

---

## 二、法律合规要求

### 2.1 德国发票法规

根据德国《增值税法》(UStG) 和《GoBD规范》，德国发票必须包含以下要素：

#### 2.1.1 强制要素
| 要素 | 说明 |
|------|------|
| 开票方信息 | 公司名称、地址、税务识别号(StNr./USt-IdNr.) |
| 客户信息 | 客户名称、地址 |
| 发票编号 | 连续编号系统（必须唯一且按时间顺序） |
| 开票日期 | 发票开具日期 |
| 服务/商品描述 | 清晰的产品或服务描述 |
| 数量与单价 | 金额、数量、计量单位 |
| 净额 | 不含税金额 |
| 税率 | 适用的VAT税率（19%, 7%, 0%） |
| 税额 | 按税率分别列明税额 |
| 总额 | 含税总金额 |
| 货币 | 欧元(€) |

#### 2.1.2 可选但推荐要素
- 客户VAT号（如涉及跨国交易）
- 原产国信息
- 银行信息（IBAN/BIC）
- 付款期限
- 折扣信息

### 2.2 GoBD合规要求

GoBD (Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung von Büchern) 是德国电子会计记录的基本法规：

| 要求 | 实现方式 |
|------|---------|
| 完整性 | 不可篡改的发票记录，所有修改留痕 |
| 准确性 | 数据校验机制，自动化对账 |
| 可追溯性 | 完整的审计日志，每笔操作可追溯 |
| 可读性 | 标准格式存储，支持长期读取 |
| 完整性保护 | 数字签名，防止未授权修改 |
| 归档要求 | 10年电子归档（符合德国税法） |

### 2.3 欧盟VAT指令

#### 2.3.1 VAT税率体系
```
德国标准税率: 19%
优惠税率: 7%（食品、书籍、医药等）
零税率: 0%（特定出口/跨境服务）
```

#### 2.3.2 反向征收机制 (Reverse Charge)
- B2B跨境服务：如果客户在另一个EU国家且有有效VAT号，销售方不收VAT，由买方自行申报
- 特定商品：建筑服务、电子产品等实行反向征收

#### 2.3.3 OSS/IOSS申报
- 支持One-Stop-Shop (OSS) 申报
- 支持Import One-Stop-Shop (IOSS) 用于进口小额商品

### 2.4 XRechnung标准

德国政府要求公共部门的电子发票必须符合XRechnung格式（基于UBL 2.1）：

```xml
<!-- XRechnung 核心结构示例 -->
<Invoice>
  <AccountingSupplierParty> <!-- 开票方 -->
  <AccountingCustomerParty> <!-- 客户方 -->
  <InvoiceLine>              <!-- 发票行项目 -->
  <TaxTotal>                 <!-- 税额汇总 -->
</Invoice>
```

---

## 三、系统架构

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                        前端 (Frontend)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  仪表盘  │  │  发票管理  │  │  会计模块  │  │  报表分析  │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  客户管理  │  │  商品目录  │  │   设置    │  │  集成中心  │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      API网关 (API Gateway)                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  认证授权  │  │  速率限制  │  │  负载均衡  │  │   监控    │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  后端服务集群    │ │   任务队列      │ │   定时任务       │
│  (Node.js/Go)   │ │  (Redis/Bull)   │ │  (Cron Jobs)    │
└─────────────────┘ └─────────────────┘ └─────────────────┘
          │                   │                   │
          └───────────────────┼───────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        数据层 (Data Layer)                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ PostgreSQL │  │  Redis   │  │  文件存储  │  │  搜索引擎  │  │
│  │  (主数据库) │  │ (缓存/队列) │  │ (S3/本地)  │  │ (Elastic) │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
     云端存储            本地备份            同步服务
   (AWS S3/          (本地NAS/           (双向同步
    云服务商)         外部硬盘)           +冲突解决)
```

### 3.2 技术栈选型

#### 3.2.1 前端技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 框架 | Next.js 14 (App Router) | React生态，SSR/SSG支持，优秀SEO |
| UI组件 | shadcn/ui + Tailwind CSS | 现代化组件库，高度可定制 |
| 状态管理 | Zustand + React Query | 轻量状态管理 + 服务端状态缓存 |
| 表单处理 | React Hook Form + Zod | 高性能表单 + 类型安全验证 |
| 数据可视化 | Recharts | 灵活图表库 |
| PDF生成 | @react-pdf/renderer | 客户端PDF生成 |
| 国际化 | next-intl | 完整的i18n支持（中/德/英） |

#### 3.2.2 后端技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 运行时 | **Node.js 22 LTS (Jod)** | 长期支持版本，稳定可靠，预计支持至2027年4月 |
| 框架 | NestJS / Fastify | 企业级后端框架 |
| API | REST + GraphQL | 灵活的数据交互 |
| ORM | Prisma | 类型安全的数据库操作 |
| 认证 | NextAuth.js + JWT | 安全的身份验证 |
| 缓存 | Redis | 高性能缓存层 |
| 队列 | BullMQ | 任务队列处理 |
| 文件存储 | S3兼容API | 云存储抽象 |
| 搜索 | Meilisearch | 快速全文搜索 |

#### 3.2.3 数据库选型

**主数据库: PostgreSQL 16**

选型理由：
- 事务完整性：ACID保证，满足GoBD要求
- JSON支持：灵活的数据存储
- 性能：成熟优化，支持高并发
- 扩展性：支持分片和复制
- 生态：丰富的GIS和时间序列扩展

**替代方案考虑**：
| 数据库 | 优势 | 劣势 |
|--------|------|------|
| PostgreSQL ✓ | 事务完整性，生态成熟 | 水平扩展相对复杂 |
| MySQL | 成熟度高 | 事务支持弱于PG |
| SQLite | 嵌入式，本地存储 | 多用户支持弱 |

**缓存层: Redis 7**
- 会话存储
- 热点数据缓存
- 实时队列
- 限流控制

#### 3.2.4 文件存储方案

```yaml
存储策略:
  云端存储:
    供应商: AWS S3 / Backblaze B2 / 自建MinIO
    存储类别: 标准存储 + Glacier归档
    生命周期: 6年标准存储 → 4年Glacier（满足10年GoBD）
  
  本地存储:
    类型: **本地硬盘**
    路径: /data/invoice-system/ (可配置)
    自动备份: 每日增量 + 每周全量
    加密: 应用层AES-256加密
  
  同步机制:
    工具: Rclone / Syncthing (可选)
    频率: 实时同步（云）+ 定时备份（本地）
    冲突解决: 最后写入优先 + 历史版本保留
```

### 3.3 部署架构

```
                    ┌─────────────────┐
                    │   CDN (Cloudflare)│
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Load Balancer   │
                    │  (nginx/Traefik) │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐ ┌───────▼────────┐ ┌────────▼────────┐
│  Web Server 1    │ │  Web Server 2    │ │  Web Server 3    │
│  (Docker/K8s)    │ │  (Docker/K8s)    │ │  (Docker/K8s)    │
└────────┬────────┘ └───────┬─────────┘ └────────┬────────┘
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │
                    ┌───────▼─────────┐
                    │  Database Cluster │
                    │  (主备复制)       │
                    └───────┬─────────┘
                            │
                    ┌───────▼─────────┐
                    │  File Storage    │
                    │  (S3 + 本地)     │
                    └─────────────────┘
```

---

## 四、功能模块设计

### 4.1 发票管理模块

#### 4.1.1 发票类型

| 类型 | 代码 | 说明 |
|------|------|------|
| 销售发票 | INV | 标准销售发票，含税 |
| 收据 | REC | 小额交易简化版 |
| 贷项通知单 | CN | 发票冲销/退款 |
| 预形式发票 | PI | 报价性质的预发票 |
| 欧盟跨境发票 | EU | 含VIES验证的反向征收 |
| 出口发票 | EXP | 免税出口发票 |
| XRechnung | XR | 政府标准电子发票 |

#### 4.1.2 发票生命周期

```
创建 → 保存(草稿) → 审核 → 发送 → 已付款/逾期 → 归档
                ↓
              取消(作废)
```

#### 4.1.3 功能清单

```
发票管理:
├── 创建发票
│   ├── 手动创建
│   ├── 从报价单转换
│   ├── 从订单转换
│   └── 批量创建
├── 编辑发票
│   ├── 修改明细
│   ├── 调整税率
│   ├── 添加折扣
│   └── 更新客户信息
├── 发票模板
│   ├── 自定义模板
│   ├── 品牌标识
│   ├── 页眉页脚
│   └── 多语言模板
├── PDF导出
│   ├── 标准PDF
│   ├── PDF/A归档格式
│   ├── XRechnung XML
│   ├── ZUGFeRD (含嵌入式XML)
│   └── **电子邮件发送**
│       ├── 邮件客户端集成 (OS默认邮箱软件)
│       │   ├── macOS: Apple Mail / Outlook
│       │   ├── Windows: Outlook / 邮件应用
│       │   └── Linux: Thunderbird / Evolution
│       ├── 自动打开本地邮件客户端
│       ├── PDF自动附件到邮件
│       ├── 预填充收件人/主题/正文
│       └── 发送记录追踪（手动记录）
├── 自动编号规则
│   ├── 前缀配置
│   ├── 编号序列
│   └── 年月分组
└── 发票状态管理
    ├── 状态流转
    ├── 逾期提醒
    └── 自动催款
```

### 4.2 客户管理模块

```
客户管理:
├── 客户档案
│   ├── 基本信息（公司/个人）
│   ├── 联系方式
│   ├── 税务信息（VAT号/StNr）
│   ├── 银行信息
│   └── 自定义字段
├── 客户分组
│   ├── 按行业分类
│   ├── 按地区分类
│   └── 按交易额分类
├── 客户黑名单
└── 客户分析
    ├── 交易历史
    ├── 付款习惯
    └── 利润贡献
```

### 4.3 商品与定价模块

```
商品管理:
├── 商品目录
│   ├── 商品/服务分类
│   ├── SKU管理
│   ├── 条码扫描
│   └── 多单位支持
├── 定价规则
│   ├── 基本价格
│   ├── 客户专属价
│   ├── 批量折扣
│   └── 促销价格
├── 库存管理
│   ├── 库存追踪
│   ├── 低库存预警
│   └── 仓库管理
└── VAT分类
    ├── 19%标准税率
    ├── 7%优惠税率
    ├── 0%零税率/免税
    └── **可配置的税率系统**
        ├── 动态税率配置
        ├── 税率生效日期设置
        ├── 税率变更历史追踪
        └── 批量税率更新
```

### 4.4 会计核算模块

#### 4.4.1 科目体系

按照德国HGB（商业法）标准会计科目表：

```
资产 (Aktiva)
├── 固定资产 (Anlagevermögen)
│   ├── 无形资产
│   ├── 有形资产
│   └── 金融资产
└── 流动资产 (Umlaufvermögen)
    ├── 存货
    ├── 债权
    └── 有价证券

负债 (Passiva)
├── 资本金 (Eigenkapital)
└── 负债 (Fremdkapital)
    ├── 长期负债
    └── 短期负债

收支 (Erträge/Aufwendungen)
├── 营业收入
├── 营业成本
├── 管理费用
└── 财务收支
```

#### 4.4.2 记账功能

```
会计核算:
├── 凭证管理
│   ├── 自动生成凭证（发票→凭证）
│   ├── 手动录入
│   ├── 凭证模板
│   └── 批量审核
├── 账簿
│   ├── 日记账
│   ├── 总账
│   ├── 明细账
│   └── 辅助账
├── 自动转账规则
│   ├── 销售收入→营收科目
│   ├── VAT→负债科目
│   └── 客户应收→债权科目
└── 月末结账
    ├── 自动结转
    ├── 调整分录
    └── 报表生成
```

### 4.5 报表与分析模块

```
报表中心:
├── 财务报表
│   ├── 资产负债表
│   ├── 损益表
│   ├── 现金流量表
│   └── 账龄分析表
├── 经营报表
│   ├── 销售报表
│   ├── 客户报表
│   ├── 商品报表
│   └── 利润分析
├── VAT报表
│   ├── 月度申报表
│   ├── 季度申报表
│   ├── 年度汇总
│   └── EU跨境报表(INTRASTAT)
├── 自动化报表
│   ├── 定期生成
│   ├── 自动发送
│   └── 报表订阅
└── 数据导出
    ├── Excel/CSV
    ├── PDF报告
    └── API接口
```

### 4.6 集成与API

```
系统集成:
├── 电子发票传输
│   ├── ZRE (Zentraler Realer Endpunkt)
│   ├── OZG标准接口
│   └── Peppol网络
├── 政府系统
│   ├── ELSTER连接（税务申报）
│   ├── GoBD导出
│   └── 审计接口
├── 支付集成
│   ├── **现金支付 (Barzahlung)**
│   │   ├── 现场收款记录
│   │   ├── 自动生成收据
│   │   └── POS集成准备
│   ├── Stripe
│   ├── PayPal
│   ├── SEPA直接扣款
│   └── 银行转账
├── 电商集成
│   ├── WooCommerce
│   ├── Shopify
│   └── Magento
└── API开放平台
    ├── RESTful API
    ├── Webhook
    └── 开发者文档
```

### 4.7 用户与权限

```
用户管理:
├── 用户角色
│   ├── 管理员（全部权限）
│   ├── 会计（记账+报表）
│   ├── 出纳（收款+付款）
│   ├── 销售（发票+客户）
│   └── 只读（报表查看）
├── 权限控制
│   ├── 模块级权限
│   ├── 数据级权限
│   └── 操作级权限
├── 多公司支持
│   ├── 公司切换
│   └── 数据隔离
└── 审计日志
    ├── 操作记录
    ├── 登录日志
    └── 数据变更追踪
```

---

## 五、数据库设计

### 5.1 ER模型概览

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│  User   │────▶│Company  │◀───│ Customer│
└─────────┘     └────┬────┘     └─────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
   ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
   │ Invoice │  │Product  │  │ Account │
   └────┬────┘  └────┬────┘  └─────────┘
        │            │
   ┌────▼────┐  ┌────▼────┐
   │LineItem │  │Category │
   └────┬────┘  └─────────┘
        │
   ┌────▼────┐
   │Payment  │
   └─────────┘
```

### 5.2 核心表结构

#### 5.2.1 组织与用户

```sql
-- 公司/企业信息
CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    legal_name VARCHAR(255),
    tax_id VARCHAR(50),           -- 税务识别号 StNr
    vat_id VARCHAR(50),           -- VAT号 USt-IdNr
    address JSONB NOT NULL,
    bank_info JSONB,
    settings JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    profile JSONB,
    preferences JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
);
```

#### 5.2.2 客户与供应商

```sql
-- 客户
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) NOT NULL,
    type VARCHAR(20) DEFAULT 'business',  -- business | individual
    name VARCHAR(255) NOT NULL,
    vat_id VARCHAR(50),
    tax_exempt BOOLEAN DEFAULT FALSE,
    address JSONB NOT NULL,
    contact JSONB,
    payment_terms INTEGER DEFAULT 30,     -- 天数
    credit_limit DECIMAL(12,2),
    tags TEXT[],
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 供应商
CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) NOT NULL,
    name VARCHAR(255) NOT NULL,
    vat_id VARCHAR(50),
    address JSONB NOT NULL,
    contact JSONB,
    bank_info JSONB,
    payment_terms INTEGER DEFAULT 30,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 5.2.3 商品与服务

```sql
-- 商品分类
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) NOT NULL,
    parent_id UUID REFERENCES categories(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 商品/服务
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) NOT NULL,
    category_id UUID REFERENCES categories(id),
    sku VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(20) DEFAULT 'good',      -- good | service
    unit VARCHAR(50) DEFAULT 'piece',
    base_price DECIMAL(12,4) NOT NULL,
    purchase_price DECIMAL(12,4),
    vat_rate DECIMAL(5,4) NOT NULL DEFAULT 0.19,
    stock_quantity DECIMAL(12,4) DEFAULT 0,
    low_stock_threshold DECIMAL(12,4),
    active BOOLEAN DEFAULT TRUE,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 5.2.4 发票核心

```sql
-- 发票主表
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) NOT NULL,
    customer_id UUID REFERENCES customers(id) NOT NULL,
    
    -- 发票号（唯一性由数据库保证）
    invoice_number VARCHAR(50) NOT NULL,
    sequence_prefix VARCHAR(20),
    sequence_year INTEGER,
    sequence_month INTEGER,
    sequence_number INTEGER,
    
    -- 类型与状态
    type VARCHAR(20) DEFAULT 'INV',        -- INV | CN | PI | EXP
    status VARCHAR(20) DEFAULT 'draft',   -- draft | sent | paid | overdue | cancelled
    
    -- 日期
    issue_date DATE NOT NULL,
    due_date DATE NOT NULL,
    
    -- 金额（冗余存储便于查询）
    subtotal DECIMAL(12,4) NOT NULL DEFAULT 0,
    total_vat DECIMAL(12,4) NOT NULL DEFAULT 0,
    total DECIMAL(12,4) NOT NULL DEFAULT 0,
    
    -- 货币与语言
    currency VARCHAR(3) DEFAULT 'EUR',
    language VARCHAR(5) DEFAULT 'de-DE',
    
    -- VAT处理
    vat_breakdown JSONB,  -- [{rate: 0.19, net: 100, vat: 19}, ...]
    reverse_charge BOOLEAN DEFAULT FALSE,
    eu_transaction BOOLEAN DEFAULT FALSE,
    
    -- 备注
    notes TEXT,
    internal_notes TEXT,
    
    -- PDF与附件
    pdf_path VARCHAR(500),
    attachments JSONB,
    
    -- 审计字段
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- 唯一性约束
    UNIQUE(company_id, invoice_number)
);

-- 发票行项目
CREATE TABLE invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    
    description VARCHAR(500) NOT NULL,
    quantity DECIMAL(12,4) NOT NULL DEFAULT 1,
    unit VARCHAR(50),
    unit_price DECIMAL(12,4) NOT NULL,
    vat_rate DECIMAL(5,4) NOT NULL DEFAULT 0.19,
    
    discount_percent DECIMAL(5,2) DEFAULT 0,
    discount_amount DECIMAL(12,4) DEFAULT 0,
    
    net_amount DECIMAL(12,4) NOT NULL,
    vat_amount DECIMAL(12,4) NOT NULL,
    gross_amount DECIMAL(12,4) NOT NULL,
    
    sort_order INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 付款记录
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID REFERENCES invoices(id) NOT NULL,
    amount DECIMAL(12,4) NOT NULL,
    currency VARCHAR(3) DEFAULT 'EUR',
    payment_date DATE NOT NULL,
    payment_method VARCHAR(50) NOT NULL,    -- bank_transfer | **cash (Barzahlung)** | check | credit_card | stripe | paypal | sepa
    reference VARCHAR(255),
    notes TEXT,
    receipt_number VARCHAR(50),              -- 现金支付收据号
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 5.2.5 会计凭证

```sql
-- 科目
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) NOT NULL,
    account_number VARCHAR(20) NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(20) NOT NULL,     -- asset | liability | equity | revenue | expense
    category VARCHAR(50),
    parent_id UUID REFERENCES accounts(id),
    is_vat_account BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, account_number)
);

-- 凭证
CREATE TABLE vouchers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) NOT NULL,
    voucher_number VARCHAR(50) NOT NULL,
    date DATE NOT NULL,
    description TEXT,
    reference_type VARCHAR(50),   -- invoice | payment | manual
    reference_id UUID,
    status VARCHAR(20) DEFAULT 'draft',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, voucher_number)
);

-- 凭证分录
CREATE TABLE voucher_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_id UUID REFERENCES vouchers(id) ON DELETE CASCADE,
    account_id UUID REFERENCES accounts(id) NOT NULL,
    description VARCHAR(255),
    debit DECIMAL(12,4) DEFAULT 0,
    credit DECIMAL(12,4) DEFAULT 0,
    vat_rate DECIMAL(5,4),
    vat_amount DECIMAL(12,4),
    sort_order INTEGER DEFAULT 0
);
```

#### 5.2.6 审计日志

```sql
-- 操作审计
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id),
    user_id UUID REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    old_data JSONB,
    new_data JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 5.2.7 VAT税率配置

```sql
-- VAT税率配置表（支持动态税率变更）
CREATE TABLE vat_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id),  -- NULL表示全局税率
    country_code VARCHAR(3) NOT NULL,          -- DE, AT, CH等
    rate DECIMAL(5,4) NOT NULL,                 -- 0.19, 0.07, 0.00
    rate_type VARCHAR(20) NOT NULL,            -- standard | reduced | zero
    name VARCHAR(100),                         -- 标准税率, 优惠税率
    effective_from DATE NOT NULL,               -- 生效日期
    effective_to DATE,                          -- 失效日期，NULL表示永久有效
    description TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 税率历史记录（不可修改）
CREATE TABLE vat_rate_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vat_rate_id UUID REFERENCES vat_rates(id),
    company_id UUID REFERENCES companies(id),
    country_code VARCHAR(3) NOT NULL,
    rate DECIMAL(5,4) NOT NULL,
    rate_type VARCHAR(20) NOT NULL,
    effective_from DATE NOT NULL,
    effective_to DATE,
    changed_by UUID REFERENCES users(id),
    changed_at TIMESTAMPTZ DEFAULT NOW(),
    change_reason TEXT
);

-- 邮件发送记录（本地邮件客户端方式）
CREATE TABLE email_sends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) NOT NULL,
    invoice_id UUID REFERENCES invoices(id),
    template_type VARCHAR(50),                 -- invoice | reminder | custom
    recipient_email VARCHAR(255) NOT NULL,
    recipient_name VARCHAR(255),
    subject VARCHAR(500),
    body_preview TEXT,                         -- 邮件内容预览
    attachment_paths JSONB,                     -- [{name, path, size}]
    status VARCHAR(20) DEFAULT 'opened',       -- opened | pending (本地客户端方式)
    sent_at TIMESTAMPTZ,                        -- 打开客户端时间
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 5.3 索引设计

```sql
-- 性能关键字段索引
CREATE INDEX idx_invoices_company_date ON invoices(company_id, issue_date);
CREATE INDEX idx_invoices_company_customer ON invoices(company_id, customer_id);
CREATE INDEX idx_invoices_company_status ON invoices(company_id, status);
CREATE INDEX idx_invoices_due_date ON invoices(due_date) WHERE status IN ('sent', 'overdue');
CREATE INDEX idx_customers_company_vat ON customers(company_id, vat_id);
CREATE INDEX idx_products_company_sku ON products(company_id, sku) WHERE sku IS NOT NULL;
```

### 5.4 数据完整性约束

```sql
-- 发票金额一致性
ALTER TABLE invoices ADD CONSTRAINT chk_invoice_totals 
    CHECK (subtotal >= 0 AND total_vat >= 0 AND total >= 0);

-- 凭证借贷平衡
ALTER TABLE vouchers ADD CONSTRAINT chk_voucher_balanced 
    CHECK (EXISTS (
        SELECT 1 FROM voucher_lines vl 
        WHERE vl.voucher_id = vouchers.id 
        GROUP BY vl.voucher_id 
        HAVING SUM(vl.debit) = SUM(vl.credit)
    ));
```

---

## 六、安全与合规

### 6.1 数据安全

```
安全措施:
├── 传输加密
│   ├── TLS 1.3
│   ├── HSTS
│   └── 证书管理（Let's Encrypt + 备用）
├── 存储加密
│   ├── 数据库字段级加密（敏感数据）
│   ├── 文件存储AES-256
│   └── 备份加密
├── 访问控制
│   ├── RBAC角色权限
│   ├── MFA双因素认证
│   └── API密钥管理
└── 监控告警
    ├── 异常登录检测
    ├── 数据访问审计
    └── 自动安全扫描
```

### 6.2 GoBD合规技术实现

| GoBD要求 | 技术实现 |
|---------|---------|
| 不可篡改性 | 哈希链 + 数字签名 |
| 完整性 | 数据校验和(CRC/MD5) |
| 可追溯性 | 完整审计日志 |
| 可读性 | 标准格式(UTF-8) |
| 防丢失 | 多地备份 + 冗余存储 |
| 防止未授权访问 | 加密 + 权限控制 |

### 6.3 数据备份策略

```
备份策略:
├── 实时备份
│   ├── 数据库WAL归档
│   └── 增量文件同步
├── 每日备份
│   ├── 全量数据库快照
│   └── 文件系统快照
├── 每周备份
│   ├── 异地冷存储
│   └── 归档验证
└── 保留策略
    ├── **日常备份: 7天**
    ├── 月度备份: 12个月
    └── 年度备份: 10年（GoBD要求）
```

---

## 七、用户界面设计

### 7.1 设计语言

#### 7.1.1 设计系统

```
设计系统 (Design System):
├── 设计原则
│   ├── 专业可信
│   ├── 简洁高效
│   └── 德国品质（精确、可靠）
│
├── 色彩系统
│   ├── 主色: #1E40AF (深蓝)
│   ├── 辅助色: #059669 (绿色，代表财务健康)
│   ├── 警示色: #DC2626 (红色，逾期/错误)
│   ├── 背景色: #F8FAFC
│   └── 文字色: #1E293B
│
├── 字体
│   ├── 标题: Inter (德语清晰度高)
│   └── 正文: Inter / Noto Sans SC (中文)
│
├── 间距系统
│   ├── 基准: 4px
│   ├── 常用: 8px / 16px / 24px / 32px
│   └── 大量留白: 48px+
│
└── 组件库
    ├── 按钮、输入框、卡片
    ├── 数据表格（虚拟滚动）
    ├── 图表可视化
    └── 发票预览组件
```

### 7.2 核心页面

```
页面结构:
├── 仪表盘 (Dashboard)
│   ├── 今日概览
│   │   ├── 待开票金额
│   │   ├── 逾期金额
│   │   ├── 本月收入
│   │   └── 待付款账单
│   ├── 快捷操作
│   │   ├── 新建发票
│   │   ├── 添加客户
│   │   └── 导入数据
│   └── 趋势图表
│       ├── 收入趋势
│       ├── 发票统计
│       └── VAT申报进度
│
├── 发票中心
│   ├── 发票列表（筛选/搜索）
│   ├── 创建/编辑发票
│   ├── 发票详情/预览
│   ├── 批量操作
│   └── 模板管理
│
├── 客户管理
│   ├── 客户列表
│   ├── 客户详情
│   ├── 交易历史
│   └── 客户分析
│
├── 会计模块
│   ├── 凭证列表
│   ├── 新建凭证
│   ├── 科目设置
│   ├── 期末结账
│   └── 账簿查看
│
├── 报表中心
│   ├── 财务报表
│   ├── 销售报表
│   ├── VAT报表
│   └── 自定义报表
│
└── 系统设置
    ├── 公司信息
    ├── 用户管理
    ├── 发票设置
    ├── 集成设置
    └── 数据备份
```

---

## 八、开发路线图

### 8.1 阶段划分

```
项目总周期: 约12-16个月

├── Phase 1: 基础架构 (2个月)
├── Phase 2: 核心功能 (4个月)
├── Phase 3: 会计模块 (3个月)
├── Phase 4: 高级功能 (3个月)
└── Phase 5: 优化与上线 (2个月)
```

### 8.2 详细计划

#### Phase 1: 基础架构（第1-2个月）

**目标**: 完成技术选型、架构搭建、基础设施

```
Week 1-2: 项目初始化
├── 开发环境搭建
├── 代码仓库初始化
├── CI/CD流水线配置
└── 数据库设计（完整ER图）
    - 评估PostgreSQL和其他必要工具
    - 完成核心表结构设计
    - 索引和约束规划

Week 3-4: 前端基础
├── Next.js项目初始化
├── UI组件库配置
├── 设计系统实现
└── 国际化(i18n)基础

Week 5-6: 后端基础
├── NestJS/Fastify API框架
├── 数据库ORM配置
├── 认证系统(JWT)
└── 基础中间件(日志、错误处理)

Week 7-8: 基础设施
├── 云存储配置(S3/MinIO)
├── Redis缓存层
├── 文件上传服务
└── 开发/测试环境部署

交付物:
✓ 可运行的开发环境
✓ 完整的数据库架构
✓ API基础框架
✓ 前端组件库
```

#### Phase 2: 核心功能（第3-6个月）

**目标**: 完成发票管理、客户管理、商品管理

```
Month 3: 客户与商品模块
├── 客户CRUD + 搜索
├── 客户分组与标签
├── 商品目录管理
├── 定价规则
└── VAT分类设置

Month 4: 发票核心功能
├── 发票创建/编辑
├── 发票模板系统
├── PDF生成(标准格式)
├── XRechnung导出
└── ZUGFeRD格式

Month 5: 发票高级功能
├── 批量操作
├── 自动编号规则
├── 发票审批流程
├── 邮件发送集成
└── 发票状态管理

Month 6: 发票收付款
├── 部分付款
├── 多笔付款
├── 贷项通知单
├── 逾期自动提醒
└── 付款对账

交付物:
✓ 完整的发票生命周期
✓ 多格式导出(XRechnung/ZUGFeRD)
✓ 客户与商品管理
✓ PDF预览与下载
```

#### Phase 3: 会计模块（第7-9个月）

**目标**: 完成会计凭证、总账、财务报表

```
Month 7: 科目与凭证
├── 会计科目表(德语HGB)
├── 凭证创建/编辑
├── 自动凭证生成规则
├── 凭证审批流程
└── 凭证查询与导出

Month 8: 账簿与结账
├── 日记账
├── 总账
├── 明细账
├── 月末结账流程
└── 年度结转

Month 9: 财务报表
├── 资产负债表
├── 损益表
├── VAT申报表
├── INTRASTAT报表
└── 自定义报表引擎

交付物:
✓ 完整的复式记账系统
✓ 德语财务报表
✓ VAT合规报表
✓ 月/年终结账
```

#### Phase 4: 高级功能（第10-12个月）

**目标**: 集成、自动化、高级报表

```
Month 10: 集成与API
├── RESTful API
├── Webhook系统
├── 第三方支付集成
├── ELSTER连接准备
└── Peppol接入准备

Month 11: 自动化与高级功能
├── 工作流自动化
├── 定期发票(订阅)
├── 自动催款
├── 多语言支持(中/英/德)
└── 高级搜索与分析

Month 12: 优化与测试
├── 性能优化
├── 安全测试
├── GoBD合规验证
├── 用户验收测试
└── 文档完善

交付物:
✓ 完整的API平台
✓ 支付集成
✓ 自动化工作流
✓ 多语言界面
✓ GoBD合规验证
```

#### Phase 5: 上线与优化（第13-16个月）

**目标**: 生产部署、持续优化

```
Month 13-14: 生产部署
├── 云服务商配置
├── 域名与SSL
├── 生产环境部署
├── 数据迁移
└── 监控告警配置

Month 15-16: 持续优化
├── 用户反馈处理
├── 功能迭代
├── 性能监控
├── 安全更新
└── 备份验证

交付物:
✓ 稳定生产系统
✓ 完整文档
✓ 运维手册
```

---

## 九、团队配置建议

### 9.1 核心团队

| 角色 | 人数 | 主要职责 |
|------|------|---------|
| 项目经理 | 1 | 项目管理、需求分析、进度把控 |
| 前端开发 | 2-3 | Next.js开发、UI组件、响应式设计 |
| 后端开发 | 2-3 | API开发、业务逻辑、数据库 |
| 设计师 | 1 | UI/UX设计、设计系统 |
| QA工程师 | 1-2 | 测试、自动化、CI/CD |
| DevOps | 1 | 基础设施、部署、监控 |

### 9.2 技能要求

```
前端:
- React / Next.js
- TypeScript
- Tailwind CSS
- React Query / Zustand
- PDF生成

后端:
- Node.js / TypeScript
- PostgreSQL / Prisma
- 认证安全(JWT, MFA)
- RESTful API设计

DevOps:
- Docker / Kubernetes
- CI/CD (GitHub Actions)
- 云服务(AWS/GCP)
- 监控(Prometheus, Grafana)

业务知识:
- 德国会计法规
- GoBD/GDPdU
- EU VAT指令
- XRechnung标准
```

---

## 十、风险与对策

### 10.1 主要风险

| 风险类别 | 风险描述 | 影响 | 对策 |
|---------|---------|------|------|
| 法律合规 | 法规理解偏差导致不合规 | 高 | 聘请德国会计顾问，定期审查 |
| 技术难度 | XRechnung/ZUGFeRD实现复杂 | 中 | 提前研究开源库，考虑收购组件 |
| 数据迁移 | 历史数据迁移风险 | 中 | 分阶段迁移，充分测试 |
| 性能 | 大数据量查询性能 | 中 | 数据库优化，缓存策略 |
| 安全 | 数据泄露风险 | 高 | 安全审计，渗透测试 |

### 10.2 应对措施

```
风险应对:
├── 法律合规
│   ├── 与德国会计事务所合作
│   ├── 定期参加合规培训
│   └── 建立合规检查清单
│
├── 技术实现
│   ├── 采用成熟开源方案
│   ├── 早期POC验证关键技术
│   └── 预留技术缓冲时间
│
└── 数据安全
    ├── 加密存储
    ├── 定期备份演练
    └── 权限最小化原则
```

---

## 十一、成功标准

### 11.1 功能验收

```
✓ 发票生成符合德国法律要求
✓ 支持XRechnung标准
✓ 完整的会计凭证系统
✓ VAT报表准确无误
✓ 数据10年可追溯
```

### 11.2 性能指标

```
✓ API响应时间 < 200ms (P95)
✓ 页面加载 < 2s
✓ 支持100+并发用户
✓ 99.9%系统可用性
```

### 11.3 合规验证

```
✓ GoBD合规认证
✓ 数据保护(GDPR)合规
✓ EU VAT指令正确实现
```

---

## 附录

### A. 术语表

| 德语 | 中文 | 说明 |
|------|------|------|
| Rechnung | 发票 |  |
| Ausgangsrechnung | 销售发票 | 发给客户的发票 |
| Eingangsrechnung | 采购发票 | 收到的供应商发票 |
| Gutschrift | 贷项通知单 | 发票冲销 |
| Steuernummer (StNr) | 税务识别号 | 德国本地税号 |
| USt-IdNr | VAT号 | 欧盟增值税号 |
| Buchhaltung | 会计 |  |
| Buchung | 记账 |  |
| Kontenplan | 会计科目表 |  |
| Bilanz | 资产负债表 |  |
| Gewinn- und Verlustrechnung | 损益表 |  |

### B. 参考标准

- GoBD (Bundesfinanzministerium)
- EU VAT Directive 2006/112/EC
- XRechnung 2.1 ( Zentralepiece )
- ZUGFeRD 2.0
- EN 16931 (European norm for e-invoicing)

### C. 联系方式

**待定**

---

**文档状态**: 待审阅  
**下一步**: 根据反馈完善后进入开发准备阶段