package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const version = "0.2.0"

type Config struct {
	ServerURL           string
	NodeID              string
	NodeName            string
	Token               string
	SharedSecret        string
	DDNSHostname        string
	DDNSZoneID          string
	DDNSZoneName        string
	Tags                []string
	Interval            time.Duration
	DDNSInterval        time.Duration
	RequestTimeout      time.Duration
	MonitorPollInterval time.Duration
	TaskPollInterval    time.Duration
	CommandTimeout      time.Duration
	DisableCommandExec  bool
	UseWebSocket        bool
	WebSocketURL        string
}

type HeartbeatPayload struct {
	NodeID       string         `json:"node_id"`
	NodeName     string         `json:"node_name"`
	NodeToken    string         `json:"node_token,omitempty"`
	AgentVersion string         `json:"agent_version"`
	Status       string         `json:"status"`
	LatencyMS    int64          `json:"latency_ms"`
	Message      string         `json:"message,omitempty"`
	Tags         []string       `json:"tags,omitempty"`
	Platform     PlatformInfo   `json:"platform"`
	Network      NetworkInfo    `json:"network"`
	Metrics      MetricsPayload `json:"metrics"`
}

type DDNSPayload struct {
	NodeID   string `json:"node_id"`
	Hostname string `json:"hostname"`
	Type     string `json:"type,omitempty"`
	Content  string `json:"content"`
	TTL      int    `json:"ttl,omitempty"`
	ZoneID   string `json:"zone_id,omitempty"`
	ZoneName string `json:"zone_name,omitempty"`
	Comment  string `json:"comment,omitempty"`
}

type MonitorDefinition struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Type           string `json:"type"`
	Target         string `json:"target"`
	IntervalSec    int    `json:"interval_sec"`
	TimeoutMS      int    `json:"timeout_ms"`
	ExpectedStatus int    `json:"expected_status"`
	Keyword        string `json:"keyword"`
	TargetNodeID   string `json:"target_node_id"`
}

type MonitorResultPayload struct {
	MonitorID string `json:"monitor_id"`
	NodeID    string `json:"node_id"`
	Status    string `json:"status"`
	LatencyMS int64  `json:"latency_ms"`
	Detail    string `json:"detail"`
}

type TaskDispatch struct {
	RunID       int64  `json:"run_id"`
	TaskID      string `json:"task_id"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	CommandText string `json:"command_text"`
}

type TaskPollResponse struct {
	OK    bool           `json:"ok"`
	Tasks []TaskDispatch `json:"tasks"`
}

type TaskResultPayload struct {
	RunID    int64  `json:"run_id"`
	NodeID   string `json:"node_id"`
	Status   string `json:"status"`
	Output   string `json:"output"`
	ExitCode int    `json:"exit_code"`
}

type PlatformInfo struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
}

type NetworkInfo struct {
	PublicIPv4  string `json:"public_ipv4,omitempty"`
	PublicIPv6  string `json:"public_ipv6,omitempty"`
	PrivateIPv4 string `json:"private_ipv4,omitempty"`
	PrivateIPv6 string `json:"private_ipv6,omitempty"`
}

type MetricsPayload struct {
	CPUCores       int     `json:"cpu_cores"`
	CPUModel       string  `json:"cpu_model,omitempty"`
	CPUUsage       float64 `json:"cpu_usage"`
	ProcessCount   int     `json:"process_count"`
	TCPConnCount   int     `json:"tcp_conn_count"`
	UDPConnCount   int     `json:"udp_conn_count"`
	MemTotal       uint64  `json:"mem_total"`
	MemUsed        uint64  `json:"mem_used"`
	SwapTotal      uint64  `json:"swap_total"`
	SwapUsed       uint64  `json:"swap_used"`
	DiskTotal      uint64  `json:"disk_total"`
	DiskUsed       uint64  `json:"disk_used"`
	NetInSpeed     uint64  `json:"net_in_speed"`
	NetOutSpeed    uint64  `json:"net_out_speed"`
	NetInTransfer  uint64  `json:"net_in_transfer"`
	NetOutTransfer uint64  `json:"net_out_transfer"`
	Load1          float64 `json:"load_1"`
	Load5          float64 `json:"load_5"`
	Load15         float64 `json:"load_15"`
	BootTime       int64   `json:"boot_time"`
}

type TokenResponse struct {
	OK        bool   `json:"ok"`
	NodeID    string `json:"node_id"`
	NodeToken string `json:"node_token"`
}

type MonitorListResponse struct {
	OK       bool                `json:"ok"`
	Monitors []MonitorDefinition `json:"monitors"`
}

type WebSocketClient struct {
	connection *websocket.Conn
	config     *Config
	reconnect  chan struct{}
	context    context.Context
	cancel     context.CancelFunc
}

type WSMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
}

func main() {
	cfg := loadConfig()
	client := &http.Client{Timeout: cfg.RequestTimeout}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("serverstatus-agent %s starting node=%s server=%s", version, cfg.NodeID, cfg.ServerURL)

	if err := run(ctx, client, &cfg); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func run(ctx context.Context, client *http.Client, cfg *Config) error {
	if cfg.UseWebSocket {
		return runWithWebSocket(ctx, cfg)
	}

	heartbeatTicker := time.NewTicker(cfg.Interval)
	defer heartbeatTicker.Stop()
	ddnsTicker := time.NewTicker(cfg.DDNSInterval)
	defer ddnsTicker.Stop()
	monitorTicker := time.NewTicker(cfg.MonitorPollInterval)
	defer monitorTicker.Stop()
	taskTicker := time.NewTicker(cfg.TaskPollInterval)
	defer taskTicker.Stop()

	monitorState := map[string]time.Time{}

	if err := sendHeartbeat(ctx, client, cfg); err != nil {
		log.Printf("initial heartbeat failed: %v", err)
	}
	if cfg.DDNSHostname != "" {
		if err := syncDDNS(ctx, client, cfg); err != nil {
			log.Printf("initial ddns sync failed: %v", err)
		}
	}
	if err := runMonitorCycle(ctx, client, cfg, monitorState); err != nil {
		log.Printf("initial monitor cycle failed: %v", err)
	}
	if err := runTaskCycle(ctx, client, cfg); err != nil {
		log.Printf("initial task cycle failed: %v", err)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-heartbeatTicker.C:
			if err := sendHeartbeat(ctx, client, cfg); err != nil {
				log.Printf("heartbeat failed: %v", err)
			}
		case <-ddnsTicker.C:
			if cfg.DDNSHostname != "" {
				if err := syncDDNS(ctx, client, cfg); err != nil {
					log.Printf("ddns sync failed: %v", err)
				}
			}
		case <-monitorTicker.C:
			if err := runMonitorCycle(ctx, client, cfg, monitorState); err != nil {
				log.Printf("monitor cycle failed: %v", err)
			}
		case <-taskTicker.C:
			if err := runTaskCycle(ctx, client, cfg); err != nil {
				log.Printf("task cycle failed: %v", err)
			}
		}
	}
}

func sendHeartbeat(ctx context.Context, client *http.Client, cfg *Config) error {
	metrics := collectMetrics()
	netInfo := collectNetwork()
	payload := HeartbeatPayload{
		NodeID:       cfg.NodeID,
		NodeName:     cfg.NodeName,
		NodeToken:    cfg.Token,
		AgentVersion: version,
		Status:       "online",
		Tags:         cfg.Tags,
		Platform: PlatformInfo{
			OS:   runtime.GOOS,
			Arch: runtime.GOARCH,
		},
		Network: netInfo,
		Metrics: metrics,
	}

	start := time.Now()
	var resp TokenResponse
	if err := doJSON(ctx, client, cfg, http.MethodPost, "/api/heartbeat", payload, &resp); err != nil {
		return err
	}
	payload.LatencyMS = time.Since(start).Milliseconds()
	if resp.NodeToken != "" && resp.NodeToken != cfg.Token {
		cfg.Token = resp.NodeToken
		log.Printf("received node token for %s; persist SERVERSTATUS_TOKEN for long-term use", cfg.NodeID)
	}
	return nil
}

func syncDDNS(ctx context.Context, client *http.Client, cfg *Config) error {
	ipv4, ipv6 := lookupPublicIPs(cfg.RequestTimeout)
	content := ipv4
	recordType := "A"
	if content == "" && ipv6 != "" {
		content = ipv6
		recordType = "AAAA"
	}
	if content == "" {
		return errors.New("no public IP available for DDNS")
	}

	payload := DDNSPayload{
		NodeID:   cfg.NodeID,
		Hostname: cfg.DDNSHostname,
		Type:     recordType,
		Content:  content,
		TTL:      60,
		ZoneID:   cfg.DDNSZoneID,
		ZoneName: cfg.DDNSZoneName,
		Comment:  "updated by serverstatus-agent",
	}
	var resp map[string]any
	return doJSON(ctx, client, cfg, http.MethodPost, "/api/ddns/update", payload, &resp)
}

func runMonitorCycle(ctx context.Context, client *http.Client, cfg *Config, state map[string]time.Time) error {
	var resp MonitorListResponse
	if err := doJSON(ctx, client, cfg, http.MethodGet, "/api/agent/monitors?node_id="+cfg.NodeID, nil, &resp); err != nil {
		return err
	}
	now := time.Now()
	for _, monitor := range resp.Monitors {
		last := state[monitor.ID]
		interval := time.Duration(max(monitor.IntervalSec, 15)) * time.Second
		if !last.IsZero() && now.Sub(last) < interval {
			continue
		}
		state[monitor.ID] = now
		result := executeMonitor(monitor)
		result.NodeID = cfg.NodeID
		if err := doJSON(ctx, client, cfg, http.MethodPost, "/api/monitor-results", result, nil); err != nil {
			log.Printf("submit monitor result failed: monitor=%s err=%v", monitor.ID, err)
		}
	}
	return nil
}

func runTaskCycle(ctx context.Context, client *http.Client, cfg *Config) error {
	var resp TaskPollResponse
	if err := doJSON(ctx, client, cfg, http.MethodPost, "/api/agent/tasks/poll", map[string]string{
		"node_id": cfg.NodeID,
	}, &resp); err != nil {
		return err
	}
	for _, task := range resp.Tasks {
		result := executeTask(ctx, cfg, task)
		if err := doJSON(ctx, client, cfg, http.MethodPost, "/api/agent/tasks/result", result, nil); err != nil {
			log.Printf("submit task result failed: run=%d err=%v", task.RunID, err)
		}
	}
	return nil
}

func executeMonitor(def MonitorDefinition) MonitorResultPayload {
	timeout := time.Duration(max(def.TimeoutMS, 1000)) * time.Millisecond
	start := time.Now()
	switch strings.ToLower(def.Type) {
	case "http":
		client := &http.Client{Timeout: timeout}
		req, err := http.NewRequest(http.MethodGet, def.Target, nil)
		if err != nil {
			return monitorDown(def.ID, "invalid request: "+err.Error(), 0)
		}
		resp, err := client.Do(req)
		if err != nil {
			return monitorDown(def.ID, err.Error(), time.Since(start).Milliseconds())
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		latency := time.Since(start).Milliseconds()
		expected := def.ExpectedStatus
		if expected == 0 {
			expected = 200
		}
		if resp.StatusCode != expected {
			return monitorDown(def.ID, fmt.Sprintf("unexpected status %d", resp.StatusCode), latency)
		}
		if def.Keyword != "" && !strings.Contains(string(body), def.Keyword) {
			return monitorDown(def.ID, "keyword mismatch", latency)
		}
		return MonitorResultPayload{MonitorID: def.ID, Status: "up", LatencyMS: latency, Detail: "http ok"}
	case "tcp":
		conn, err := net.DialTimeout("tcp", def.Target, timeout)
		if err != nil {
			return monitorDown(def.ID, err.Error(), time.Since(start).Milliseconds())
		}
		_ = conn.Close()
		return MonitorResultPayload{MonitorID: def.ID, Status: "up", LatencyMS: time.Since(start).Milliseconds(), Detail: "tcp ok"}
	case "icmp", "ping":
		return executePingMonitor(def, timeout, start)
	default:
		return monitorDown(def.ID, "unsupported monitor type", 0)
	}
}

func executePingMonitor(def MonitorDefinition, timeout time.Duration, start time.Time) MonitorResultPayload {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	args := []string{}
	if runtime.GOOS == "windows" {
		args = []string{"-n", "1", def.Target}
	} else {
		args = []string{"-c", "1", def.Target}
	}
	cmd := exec.CommandContext(ctx, "ping", args...)
	out, err := cmd.CombinedOutput()
	latency := time.Since(start).Milliseconds()
	if ctx.Err() == context.DeadlineExceeded {
		return monitorDown(def.ID, "ping timeout", latency)
	}
	if err != nil {
		return monitorDown(def.ID, trimOutput(string(out)), latency)
	}
	return MonitorResultPayload{MonitorID: def.ID, Status: "up", LatencyMS: latency, Detail: "ping ok"}
}

func monitorDown(id, detail string, latency int64) MonitorResultPayload {
	return MonitorResultPayload{
		MonitorID: id,
		Status:    "down",
		LatencyMS: latency,
		Detail:    trimOutput(detail),
	}
}

func executeTask(parent context.Context, cfg *Config, task TaskDispatch) TaskResultPayload {
	result := TaskResultPayload{
		RunID:  task.RunID,
		NodeID: cfg.NodeID,
		Status: "failed",
	}
	if cfg.DisableCommandExec {
		result.Output = "command execution disabled by configuration"
		result.ExitCode = 126
		return result
	}
	if strings.TrimSpace(task.CommandText) == "" {
		result.Output = "empty command"
		result.ExitCode = 64
		return result
	}

	ctx, cancel := context.WithTimeout(parent, cfg.CommandTimeout)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", task.CommandText)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-lc", task.CommandText)
	}
	out, err := cmd.CombinedOutput()
	result.Output = trimOutput(string(out))

	if ctx.Err() == context.DeadlineExceeded {
		result.Status = "timeout"
		result.ExitCode = 124
		return result
	}
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = 1
		}
		return result
	}
	result.Status = "success"
	result.ExitCode = 0
	return result
}

func doJSON(ctx context.Context, client *http.Client, cfg *Config, method, path string, payload any, target any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(cfg.ServerURL, "/")+path, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+authToken(cfg))

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("request failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	if target == nil || len(respBody) == 0 {
		return nil
	}
	return json.Unmarshal(respBody, target)
}

func authToken(cfg *Config) string {
	if cfg.Token != "" {
		return cfg.Token
	}
	return cfg.SharedSecret
}

func loadConfig() Config {
	var cfg Config
	flag.StringVar(&cfg.ServerURL, "server", envOr("SERVERSTATUS_SERVER", "http://127.0.0.1:8787"), "worker base url")
	flag.StringVar(&cfg.NodeID, "node-id", envOr("SERVERSTATUS_NODE_ID", hostOr("unknown-node")), "stable node id")
	flag.StringVar(&cfg.NodeName, "node-name", envOr("SERVERSTATUS_NODE_NAME", hostOr("unknown-node")), "display name")
	flag.StringVar(&cfg.Token, "token", envOr("SERVERSTATUS_TOKEN", ""), "node token")
	flag.StringVar(&cfg.SharedSecret, "shared-secret", envOr("SERVERSTATUS_SHARED_SECRET", ""), "shared secret")
	flag.StringVar(&cfg.DDNSHostname, "ddns-hostname", envOr("SERVERSTATUS_DDNS_HOSTNAME", ""), "hostname to sync")
	flag.StringVar(&cfg.DDNSZoneID, "ddns-zone-id", envOr("SERVERSTATUS_DDNS_ZONE_ID", ""), "optional zone id")
	flag.StringVar(&cfg.DDNSZoneName, "ddns-zone-name", envOr("SERVERSTATUS_DDNS_ZONE_NAME", ""), "optional zone name")
	flag.BoolVar(&cfg.DisableCommandExec, "disable-command-exec", envBool("SERVERSTATUS_DISABLE_COMMAND_EXEC", false), "disable remote command execution")
	flag.BoolVar(&cfg.UseWebSocket, "use-websocket", envBool("SERVERSTATUS_USE_WEBSOCKET", false), "use WebSocket connection instead of HTTP")
	flag.StringVar(&cfg.WebSocketURL, "websocket-url", envOr("SERVERSTATUS_WEBSOCKET_URL", ""), "WebSocket connection URL")

	interval := flag.Duration("interval", envDuration("SERVERSTATUS_INTERVAL", 30*time.Second), "heartbeat interval")
	ddnsInterval := flag.Duration("ddns-interval", envDuration("SERVERSTATUS_DDNS_INTERVAL", 5*time.Minute), "ddns interval")
	timeout := flag.Duration("timeout", envDuration("SERVERSTATUS_TIMEOUT", 10*time.Second), "request timeout")
	monitorPollInterval := flag.Duration("monitor-poll-interval", envDuration("SERVERSTATUS_MONITOR_POLL_INTERVAL", 20*time.Second), "monitor poll interval")
	taskPollInterval := flag.Duration("task-poll-interval", envDuration("SERVERSTATUS_TASK_POLL_INTERVAL", 15*time.Second), "task poll interval")
	commandTimeout := flag.Duration("command-timeout", envDuration("SERVERSTATUS_COMMAND_TIMEOUT", 5*time.Minute), "command timeout")
	tags := flag.String("tags", envOr("SERVERSTATUS_TAGS", ""), "comma separated node tags")
	flag.Parse()

	cfg.Interval = *interval
	cfg.DDNSInterval = *ddnsInterval
	cfg.RequestTimeout = *timeout
	cfg.MonitorPollInterval = *monitorPollInterval
	cfg.TaskPollInterval = *taskPollInterval
	cfg.CommandTimeout = *commandTimeout
	cfg.Tags = splitCSV(*tags)
	cfg.Interval = clampDuration(cfg.Interval, 30*time.Second)
	cfg.DDNSInterval = clampDuration(cfg.DDNSInterval, 5*time.Minute)
	cfg.RequestTimeout = clampDuration(cfg.RequestTimeout, 10*time.Second)
	cfg.MonitorPollInterval = clampDuration(cfg.MonitorPollInterval, 20*time.Second)
	cfg.TaskPollInterval = clampDuration(cfg.TaskPollInterval, 15*time.Second)
	cfg.CommandTimeout = clampDuration(cfg.CommandTimeout, 5*time.Minute)

	// 如果启用WebSocket但没有设置URL，则从ServerURL推导
	if cfg.UseWebSocket && cfg.WebSocketURL == "" {
		if cfg.ServerURL != "" {
			// 将HTTP URL转换为WebSocket URL
			wsURL := strings.Replace(cfg.ServerURL, "http://", "ws://", 1)
			wsURL = strings.Replace(wsURL, "https://", "wss://", 1)
			cfg.WebSocketURL = wsURL
		}
	}

	if cfg.ServerURL == "" {
		log.Fatal("server url is required")
	}
	if cfg.NodeID == "" {
		log.Fatal("node id is required")
	}
	if cfg.Token == "" && cfg.SharedSecret == "" {
		log.Fatal("either SERVERSTATUS_TOKEN or SERVERSTATUS_SHARED_SECRET is required")
	}
	if cfg.UseWebSocket && cfg.WebSocketURL == "" {
		log.Fatal("WebSocket URL is required when using WebSocket mode")
	}
	return cfg
}

func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, item := range parts {
		item = strings.TrimSpace(item)
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	d, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return d
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes" || value == "on"
}

func hostOr(fallback string) string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return fallback
	}
	return name
}

func lookupPublicIPs(timeout time.Duration) (string, string) {
	client := &http.Client{Timeout: timeout}
	ipv4 := fetchIP(client, "https://ipv4.icanhazip.com")
	ipv6 := fetchIP(client, "https://ipv6.icanhazip.com")
	return strings.TrimSpace(ipv4), strings.TrimSpace(ipv6)
}

func fetchIP(client *http.Client, url string) string {
	resp, err := client.Get(url)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(body))
}

func collectNetwork() NetworkInfo {
	var out NetworkInfo
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, addr := range addrs {
		ipnet, ok := addr.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() {
			continue
		}
		ip := ipnet.IP
		if ip4 := ip.To4(); ip4 != nil {
			if isPrivateIPv4(ip4) && out.PrivateIPv4 == "" {
				out.PrivateIPv4 = ip4.String()
			}
			continue
		}
		if ip.To16() != nil && out.PrivateIPv6 == "" {
			out.PrivateIPv6 = ip.String()
		}
	}
	out.PublicIPv4, out.PublicIPv6 = lookupPublicIPs(5 * time.Second)
	return out
}

func isPrivateIPv4(ip net.IP) bool {
	return ip.IsPrivate()
}

func trimOutput(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 8000 {
		return value[:8000]
	}
	return value
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clampDuration(value, fallback time.Duration) time.Duration {
	if value <= 0 {
		return fallback
	}
	return value
}

func runWithWebSocket(ctx context.Context, cfg *Config) error {
	wsCtx, cancel := context.WithCancel(ctx)

	wsClient := &WebSocketClient{
		config:    cfg,
		reconnect: make(chan struct{}, 1),
		context:   wsCtx,
		cancel:    cancel,
	}

	// 初始连接
	if err := wsClient.connect(); err != nil {
		log.Printf("initial WebSocket connection failed: %v", err)
	}

	// 启动心跳发送器
	heartbeatTicker := time.NewTicker(cfg.Interval)
	defer heartbeatTicker.Stop()

	// 启动重连器
	reconnectTicker := time.NewTicker(10 * time.Second)
	defer reconnectTicker.Stop()

	for {
		select {
		case <-wsClient.context.Done():
			return wsClient.context.Err()
		case <-heartbeatTicker.C:
			if wsClient.connection != nil {
				if err := wsClient.sendHeartbeat(); err != nil {
					log.Printf("WebSocket heartbeat failed: %v", err)
					wsClient.disconnect()
				}
			}
		case <-reconnectTicker.C:
			if wsClient.connection == nil {
				if err := wsClient.connect(); err != nil {
					log.Printf("WebSocket reconnection failed: %v", err)
				}
			}
		case <-wsClient.reconnect:
			if wsClient.connection != nil {
				wsClient.disconnect()
			}
			// 立即尝试重连
			if err := wsClient.connect(); err != nil {
				log.Printf("WebSocket reconnection failed: %v", err)
			}
		}
	}
}

func (ws *WebSocketClient) connect() error {
	if ws.config.WebSocketURL == "" {
		return errors.New("WebSocket URL not configured")
	}

	// 构建WebSocket URL
	u, err := url.Parse(ws.config.WebSocketURL)
	if err != nil {
		return fmt.Errorf("invalid WebSocket URL: %v", err)
	}

	// 添加查询参数
	q := u.Query()
	q.Set("node_id", ws.config.NodeID)
	q.Set("token", ws.config.SharedSecret)
	u.RawQuery = q.Encode()

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		return fmt.Errorf("WebSocket dial failed: %v", err)
	}

	ws.connection = conn
	log.Printf("WebSocket connected to %s", u.String())

	// 启动消息读取器
	go ws.readMessages()

	// 发送初始心跳
	return ws.sendHeartbeat()
}

func (ws *WebSocketClient) disconnect() {
	if ws.connection != nil {
		ws.connection.Close()
		ws.connection = nil
		log.Printf("WebSocket disconnected")
	}
}

func (ws *WebSocketClient) readMessages() {
	defer ws.disconnect()

	for {
		select {
		case <-ws.context.Done():
			return
		default:
			var msg WSMessage
			err := ws.connection.ReadJSON(&msg)
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("WebSocket read error: %v", err)
				}
				return
			}

			switch msg.Type {
			case "ping":
				ws.sendMessage("pong", nil)
			case "pong":
				// 收到pong，连接正常
			case "heartbeat_ack":
				log.Printf("Heartbeat acknowledged")
			case "error":
				log.Printf("Server error: %v", msg.Payload)
			default:
				log.Printf("Unknown message type: %s", msg.Type)
			}
		}
	}
}

func (ws *WebSocketClient) sendHeartbeat() error {
	metrics := collectMetrics()
	netInfo := collectNetwork()

	payload := HeartbeatPayload{
		NodeID:       ws.config.NodeID,
		NodeName:     ws.config.NodeName,
		AgentVersion: version,
		Status:       "online",
		Tags:         ws.config.Tags,
		Platform: PlatformInfo{
			OS:   runtime.GOOS,
			Arch: runtime.GOARCH,
		},
		Network: netInfo,
		Metrics: metrics,
	}

	return ws.sendMessage("heartbeat", payload)
}

func (ws *WebSocketClient) sendMessage(msgType string, payload interface{}) error {
	if ws.connection == nil {
		return errors.New("WebSocket not connected")
	}

	msg := WSMessage{
		Type:    msgType,
		Payload: payload,
	}

	return ws.connection.WriteJSON(msg)
}
