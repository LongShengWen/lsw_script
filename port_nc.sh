#!/bin/bash

# 维持目录下所有文件端口存活
# 文件内容格式为 IP:Port

# 指定目录
directory="/data/project/stun"

# 日志文件路径
log_file="/data/logs/port_check.log"

# 获取目录中所有文件
files=$(ls $directory)

# 遍历每个文件
for file in $files
do
    # 读取文件内容（IP:端口）
    address=$(cat "$directory/$file")
    ip=$(echo $address | cut -d: -f1)
    port=$(echo $address | cut -d: -f2)
    
    # 检查端口是否存活
    echo "Test" | nc $ip $port &> /dev/null

    if [ $? -eq 0 ]; then
        echo "$(date): $ip:$port is up" >> $log_file
    else
        echo "$(date): $ip:$port is down" >> $log_file
    fi
done
