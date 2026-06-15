const express = require('express');
const path = require('path');
const app = express();
const PORT = 3802;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎨 陶土工坊前端服务已启动`);
  console.log(`👤 顾客前台: http://localhost:${PORT}`);
  console.log(`⚙️  管理后台: http://localhost:${PORT}/admin\n`);
});
