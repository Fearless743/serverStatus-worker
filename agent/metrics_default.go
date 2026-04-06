//go:build !linux && !darwin

package main

import "runtime"

func collectMetrics() MetricsPayload {
	return MetricsPayload{
		CPUCores:       runtime.NumCPU(),
		ProcessCount:    0,
		TCPConnCount:    0,
		UDPConnCount:    0,
		MemTotal:        0,
		MemUsed:         0,
		SwapTotal:       0,
		SwapUsed:        0,
		DiskTotal:       0,
		DiskUsed:        0,
		NetInSpeed:      0,
		NetOutSpeed:     0,
		NetInTransfer:   0,
		NetOutTransfer:  0,
		Load1:           0,
		Load5:           0,
		Load15:          0,
		BootTime:        0,
		CPUUsage:        0,
	}
}
