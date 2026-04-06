//go:build linux

package main

import (
	"bufio"
	"os"
	"path/filepath"
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
		CPUCores: runtime.NumCPU(),
	}

	metrics.CPUModel = readCPUModel()
	metrics.ProcessCount = readProcessCount()
	metrics.TCPConnCount = readSocketCount("tcp") + readSocketCount("tcp6")
	metrics.UDPConnCount = readSocketCount("udp") + readSocketCount("udp6")

	load1, load5, load15 := readLoadAvg()
	metrics.Load1 = load1
	metrics.Load5 = load5
	metrics.Load15 = load15

	memTotal, memUsed, swapTotal, swapUsed := readMemInfo()
	metrics.MemTotal = memTotal
	metrics.MemUsed = memUsed
	metrics.SwapTotal = swapTotal
	metrics.SwapUsed = swapUsed

	diskTotal, diskUsed := readDiskUsage("/")
	metrics.DiskTotal = diskTotal
	metrics.DiskUsed = diskUsed

	netInTransfer, netOutTransfer, netInSpeed, netOutSpeed := readNetworkStats()
	metrics.NetInTransfer = netInTransfer
	metrics.NetOutTransfer = netOutTransfer
	metrics.NetInSpeed = netInSpeed
	metrics.NetOutSpeed = netOutSpeed
	metrics.BootTime = readBootTime()
	metrics.CPUUsage = readCPUUsage()

	return metrics
}

func readLoadAvg() (float64, float64, float64) {
	data, err := os.ReadFile("/proc/loadavg")
	if err == nil {
		fields := strings.Fields(string(data))
		if len(fields) >= 3 {
			return atof(fields[0]), atof(fields[1]), atof(fields[2])
		}
	}
	return 0, 0, 0
}

func readMemInfo() (uint64, uint64, uint64, uint64) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, 0, 0
	}
	defer file.Close()

	var memTotal uint64
	var memAvailable uint64
	var swapTotal uint64
	var swapFree uint64
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			memTotal = parseMemKB(line)
		case strings.HasPrefix(line, "MemAvailable:"):
			memAvailable = parseMemKB(line)
		case strings.HasPrefix(line, "SwapTotal:"):
			swapTotal = parseMemKB(line)
		case strings.HasPrefix(line, "SwapFree:"):
			swapFree = parseMemKB(line)
		}
	}
	if memAvailable > memTotal {
		memAvailable = 0
	}
	if swapFree > swapTotal {
		swapFree = 0
	}
	return memTotal, memTotal - memAvailable, swapTotal, swapTotal - swapFree
}

func parseMemKB(line string) uint64 {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	value, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return value * 1024
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
	data, err := os.ReadFile("/proc/cpuinfo")
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "model name") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					return strings.TrimSpace(parts[1])
				}
			}
		}
	}
	return runtime.GOARCH
}

func readProcessCount() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if _, err := strconv.Atoi(entry.Name()); err == nil {
			count += 1
		}
	}
	return count
}

func readSocketCount(kind string) int {
	file, err := os.Open(filepath.Join("/proc/net", kind))
	if err != nil {
		return 0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	count := -1
	for scanner.Scan() {
		count += 1
	}
	if count < 0 {
		return 0
	}
	return count
}

func readNetworkStats() (uint64, uint64, uint64, uint64) {
	file, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0, 0, 0
	}
	defer file.Close()

	var recv uint64
	var sent uint64
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.Contains(line, ":") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		iface := strings.TrimSpace(parts[0])
		if iface == "lo" || strings.HasPrefix(iface, "docker") || strings.HasPrefix(iface, "veth") {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) < 16 {
			continue
		}
		recv += atou(fields[0])
		sent += atou(fields[8])
	}

	now := time.Now()
	var inSpeed uint64
	var outSpeed uint64
	netSampleState.Lock()
	if netSampleState.started {
		elapsed := now.Sub(netSampleState.at).Seconds()
		if elapsed > 0 {
			if recv >= netSampleState.recv {
				inSpeed = uint64(float64(recv-netSampleState.recv) / elapsed)
			}
			if sent >= netSampleState.sent {
				outSpeed = uint64(float64(sent-netSampleState.sent) / elapsed)
			}
		}
	}
	netSampleState.recv = recv
	netSampleState.sent = sent
	netSampleState.at = now
	netSampleState.started = true
	netSampleState.Unlock()

	return recv, sent, inSpeed, outSpeed
}

func readBootTime() int64 {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return 0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "btime ") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				value, err := strconv.ParseInt(parts[1], 10, 64)
				if err == nil {
					return value
				}
			}
		}
	}
	return 0
}

func readCPUUsage() float64 {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return 0
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)
			if len(fields) >= 8 {
				// CPU time fields: user, nice, system, idle, iowait, irq, softirq, steal
				user := atou(fields[1])
				nice := atou(fields[2])
				system := atou(fields[3])
				idle := atou(fields[4])
				iowait := atou(fields[5])
				irq := atou(fields[6])
				softirq := atou(fields[7])
				steal := uint64(0)
				if len(fields) > 8 {
					steal = atou(fields[8])
				}

				busy := user + nice + system + irq + softirq + steal
				total := busy + idle + iowait

				now := time.Now()
				var usage float64
				cpuSampleState.Lock()
				if cpuSampleState.started {
					elapsed := now.Sub(cpuSampleState.at).Seconds()
					if elapsed > 0 {
						busyDelta := busy - cpuSampleState.busy
						totalDelta := total - cpuSampleState.total
						if totalDelta > 0 {
							usage = (float64(busyDelta) / float64(totalDelta)) * 100
						}
					}
				}
				cpuSampleState.busy = busy
				cpuSampleState.total = total
				cpuSampleState.at = now
				cpuSampleState.started = true
				cpuSampleState.Unlock()

				return usage
			}
		}
	}
	return 0
}

func atou(value string) uint64 {
	n, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func atof(value string) float64 {
	n, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0
	}
	return n
}
