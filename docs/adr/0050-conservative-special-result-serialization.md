# 特殊返回结构采用保守且显式的序列化

重复 DataFrame 列名或字符串化后碰撞的列名使调用失败；Series 按单列表格及既定索引规则处理，未命名值字段使用 `_value`；NumPy 数组保持维度转为嵌套数组，tuple、dict 和 list 递归严格转换。set、生成器、任意迭代器和自定义对象不得自动展开或字符串化，返回 `UNSUPPORTED_RESULT_TYPE`，只有注册表中的显式适配器可以增加支持。
