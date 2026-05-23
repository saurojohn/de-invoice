# German Invoice System - Backend

## 技术栈
- Node.js 22 LTS
- NestJS
- Prisma ORM
- PostgreSQL

## 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env 设置数据库连接
```

### 3. 数据库设置
```bash
# 生成 Prisma Client
npm run prisma:generate

# 创建数据库表
npm run prisma:push
# 或使用迁移
npm run prisma:migrate
```

### 4. 启动开发服务器
```bash
npm run dev
```

API 将在 http://localhost:3001/api/v1 运行

## API 端点

### 认证
- POST /api/v1/auth/register - 注册新用户
- POST /api/v1/auth/login - 用户登录

### 公司
- GET /api/v1/companies/:id - 获取公司信息
- PUT /api/v1/companies/:id - 更新公司信息

### 客户
- GET /api/v1/customers?companyId=xxx - 获取客户列表
- POST /api/v1/customers - 创建客户
- PUT /api/v1/customers/:id - 更新客户

### 发票
- GET /api/v1/invoices?companyId=xxx - 获取发票列表
- GET /api/v1/invoices/:id - 获取发票详情
- POST /api/v1/invoices - 创建发票
- PUT /api/v1/invoices/:id - 更新发票
- PUT /api/v1/invoices/:id/status - 更新发票状态

### 商品
- GET /api/v1/products?companyId=xxx - 获取商品列表
- POST /api/v1/products - 创建商品
- PUT /api/v1/products/:id - 更新商品

### VAT税率
- GET /api/v1/vat-rates?countryCode=DE - 获取VAT税率
- GET /api/v1/vat-rates/current?countryCode=DE - 获取当前税率
- POST /api/v1/vat-rates - 创建新税率
