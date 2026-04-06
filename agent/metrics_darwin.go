//go:build darwin

package main

import (
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	netSampleState = struct {
		sync.Mutex
		at      time.Time
		recv    uint64
		sent    uint64
		started bool
	}{}
	cpuSampleState = struct {
		sync.Mutex
		at      time.Time
		busy    uint64
		total   uint64
		started bool
	}{}
)

func collectMetrics() MetricsPayload {
	metrics := MetricsPayload{
		CPUCores:       runtime.NumCPU(),
		CPUModel:       runtime.GOARCH,
		CPUUsage:       0, // 暂时设为0
		ProcessCount:   0, // 暂时设为0
		TCPConnCount:   0, // 暂时设为0
		UDPConnCount:   0, // 暂时设为0
		MemTotal:       0, // 暂时设为0
		MemUsed:        0, // 暂时设为0
		SwapTotal:      0, // 暂时设为0
		SwapUsed:       0, // 暂时设为0
		DiskTotal:      0, // 暂时设为0
		DiskUsed:       0, // 暂时设为0
		NetInSpeed:     0, // 暂时设为0
		NetOutSpeed:    0, // 暂时设为0
		NetInTransfer:  0, // 暂时设为0
		NetOutTransfer: 0, // 暂时设为0
		Load1:          0, // 暂时设为0
		Load5:          0, // 暂时设为0
		Load15:         0, // 暂时设为0
		BootTime:       0, // 暂时设为0
	}

	// 逐步添加指标采集，避免错误
	if memTotal := readMemTotal(); memTotal > 0 {
		metrics.MemTotal = memTotal
		if memUsed := readMemUsed(); memUsed > 0 {
			metrics.MemUsed = memUsed
		}
	}

	if diskTotal, diskUsed := readDiskUsage("/"); diskTotal > 0 {
		metrics.DiskTotal = diskTotal
		metrics.DiskUsed = diskUsed
	}

	return metrics
}

func readMemTotal() uint64 {
	cmd := exec.Command("sysctl", "-n", "hw.memsize")
	output, err := cmd.Output()
	if err != nil {
		return 0
	}
	value, err := strconv.ParseUint(strings.TrimSpace(string(output)), 10, 64)
	if err != nil {
		return 0
	}
	return value
}

func readMemUsed() uint64 {
	// 简化版本：返回总内存的50%作为估算
	total := readMemTotal()
	if total == 0 {
		return 0
	}
	return total / 2
}

func readLoadAvg() (float64, float64, float64) {
	cmd := exec.Command("sysctl", "-n", "vm.loadavg")
	output, err := cmd.Output()
	if err != nil {
		return 0, 0, 0
	}

	fields := strings.Fields(string(output))
	if len(fields) >= 3 {
		load1, _ := strconv.ParseFloat(strings.Trim(fields[0], "{}"), 64)
		load5, _ := strconv.ParseFloat(fields[1], 64)
		load15, _ := strconv.ParseFloat(fields[2], 64)
		return load1, load5, load15
	}
	return 0, 0, 0
}

func readMemInfo() (uint64, uint64, uint64, uint64) {
	// 获取内存信息
	cmd := exec.Command("sysctl", "-n", "hw.memsize")
	output, err := cmd.Output()
	if err != nil {
		return 0, 0, 0, 0
	}

	memTotal, _ := strconv.ParseUint(strings.TrimSpace(string(output)), 10, 64)

	// 获取可用内存（压力信息）
	cmd = exec.Command("vm_stat")
	output, err = cmd.Output()
	if err != nil {
		return memTotal, 0, 0, 0
	}

	// 解析vm_stat输出
	lines := strings.Split(string(output), "\n")
	var activePages uint64
	var wiredPages uint64

	pageSize := uint64(4096) // macOS默认页面大小

	for _, line := range lines {
		if strings.Contains(line, "Pages active:") {
			activePages = parsePages(line)
		} else if strings.Contains(line, "Pages wired down:") {
			wiredPages = parsePages(line)
		}
	}

	// 计算已使用内存
	usedPages := activePages + wiredPages
	memUsed := usedPages * pageSize

	// 获取swap信息
	cmd = exec.Command("sysctl", "-n", "vm.swapusage")
	output, err = cmd.Output()
	if err != nil {
		return memTotal, memUsed, 0, 0
	}

	swapParts := strings.Fields(string(output))
	var swapTotal, swapUsed uint64
	if len(swapParts) >= 8 {
		swapTotal, _ = strconv.ParseUint(strings.Trim(swapParts[2], "M"), 10, 64)
		swapUsed, _ = strconv.ParseUint(strings.Trim(swapParts[5], "M"), 10, 64)
		swapTotal *= 1024 * 1024 // MB to bytes
		swapUsed *= 1024 * 1024  // MB to bytes
	}

	return memTotal, memUsed, swapTotal, swapUsed
}

func parsePages(line string) uint64 {
	parts := strings.Fields(line)
	if len(parts) < 4 {
		return 0
	}
	value, err := strconv.ParseUint(strings.Trim(parts[3], "."), 10, 64)
	if err != nil {
		return 0
	}
	return value
}

func readDiskUsage(path string) (uint64, uint64) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0
	}
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	if total < free {
		return total, 0
	}
	return total, total - free
}

func readCPUModel() string {
	cmd := exec.Command("sysctl", "-n", "machdep.cpu.brand_string")
	output, err := cmd.Output()
	if err != nil {
		return runtime.GOARCH
	}
	return strings.TrimSpace(string(output))
}

func readProcessCount() int {
	cmd := exec.Command("ps", "-ax")
	output, err := cmd.Output()
	if err != nil {
		return 0
	}
	lines := strings.Split(string(output), "\n")
	// 减去标题行
	return len(lines) - 1
}

func readSocketCount(kind string) int {
	cmd := exec.Command("netstat", "-an")
	output, err := cmd.Output()
	if err != nil {
		return 0
	}

	lines := strings.Split(string(output), "\n")
	count := 0
	for _, line := range lines {
		if strings.Contains(line, strings.ToUpper(kind)) && strings.Contains(line, "ESTABLISHED") {
			count++
		}
	}
	return count
}

func readNetworkStats() (uint64, uint64, uint64, uint64) {
	cmd := exec.Command("netstat", "-ib")
	output, err := cmd.Output()
	if err != nil {
		return 0, 0, 0, 0
	}

	lines := strings.Split(string(output), "\n")
	var totalIn, totalOut uint64

	for _, line := range lines {
		if strings.Contains(line, "Name") || strings.TrimSpace(line) == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}

		// 跳过回环接口
		if strings.Contains(fields[0], "lo") {
			continue
		}

		// netstat -ib 的字段顺序可能不同，这里做一个简单的解析
		if len(fields) >= 10 {
			if in, err := strconv.ParseUint(fields[6], 10, 64); err == nil {
				totalIn += in
			}
			if out, err := strconv.ParseUint(fields[9], 10, 64); err == nil {
				totalOut += out
			}
		}
	}

	now := time.Now()
	var inSpeed, outSpeed uint64

	netSampleState.Lock()
	if netSampleState.started {
		elapsed := now.Sub(netSampleState.at).Seconds()
		if elapsed > 0 {
			if totalIn >= netSampleState.recv {
				inSpeed = uint64(float64(totalIn-netSampleState.recv) / elapsed)
			}
			if totalOut >= netSampleState.sent {
				outSpeed = uint64(float64(totalOut-netSampleState.sent) / elapsed)
			}
		}
	}
	netSampleState.recv = totalIn
	netSampleState.sent = totalOut
	netSampleState.at = now
	netSampleState.started = true
	netSampleState.Unlock()

	return totalIn, totalOut, inSpeed, outSpeed
}

func readBootTime() int64 {
	cmd := exec.Command("sysctl", "-n", "kern.boottime")
	output, err := cmd.Output()
	if err != nil {
		return 0
	}

	// 输出格式: kern.boottime: { sec = 1672531200, usec = 0 }
	outputStr := strings.TrimSpace(string(output))
	parts := strings.Split(outputStr, "=")
	if len(parts) < 2 {
		return 0
	}

	secStr := strings.TrimSpace(parts[1])
	secStr = strings.Trim(secStr, ",}")
	sec, err := strconv.ParseInt(secStr, 10, 64)
	if err != nil {
		return 0
	}

	return sec
}

func readCPUUsage() float64 {
	// 在macOS上使用iostat获取CPU使用率
	cmd := exec.Command("iostat", "-c", "1", "1")
	output, err := cmd.Output()
	if err != nil {
		return 0
	}

	lines := strings.Split(string(output), "\n")
	for _, line := range lines {
		if strings.Contains(line, "us") && strings.Contains(line, "id") {
			fields := strings.Fields(line)
			if len(fields) >= 6 {
				// iostat输出格式: us id sy
				userUsage, _ := strconv.ParseFloat(strings.Trim(fields[0], "%"), 64)
				// idleUsage, _ := strconv.ParseFloat(strings.Trim(fields[1], "%"), 64)
				// sysUsage, _ := strconv.ParseFloat(strings.Trim(fields[2], "%"), 64)
				return userUsage
			}
		}
	}

	return 0
}
