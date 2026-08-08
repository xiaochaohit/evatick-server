# 所有结果使用严格 JSON 序列化

CLI 输出必须能被标准 JSON 解析器读取。DataFrame 序列化为行对象数组，时间使用 ISO 8601，日期使用 `YYYY-MM-DD`，`NaN`、`NaT` 和正负无穷转换为 `null`，NumPy 标量转换为原生 JSON 类型，Decimal 转成字符串以避免精度损失，bytes 使用 Base64，Path 使用路径字符串；禁止输出 `NaN` 等非标准 JSON 扩展值。
