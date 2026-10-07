package controller

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
)

type DatabaseConfig struct {
	Host       string
	Port       uint16
	Database   string
	User       string
	Password   string
	ServerName string
	CAPEM      []byte
	Schema     string
}

type Postgres struct {
	pool         *pgxpool.Pool
	controllerID string
	schema       string
}

var dbIdentifier = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
var controllerIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$`)

func OpenPostgres(ctx context.Context, config DatabaseConfig, controllerID string) (*Postgres, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if config.Host == "" || config.Port == 0 || config.Database == "" || config.User == "" || config.Password == "" || config.ServerName == "" || !dbIdentifier.MatchString(config.Schema) || !controllerIdentifier.MatchString(controllerID) {
		return nil, errors.New("invalid_database_config")
	}
	poolConfig, err := pgxpool.ParseConfig("")
	if err != nil {
		return nil, errors.New("invalid_database_config")
	}
	ca := x509.NewCertPool()
	if !ca.AppendCertsFromPEM(config.CAPEM) {
		return nil, errors.New("invalid_database_ca")
	}
	connection := poolConfig.ConnConfig
	connection.Host = config.Host
	connection.Port = config.Port
	connection.Database = config.Database
	connection.User = config.User
	connection.Password = config.Password
	connection.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: config.ServerName, RootCAs: ca}
	connection.Fallbacks = nil
	connection.ConnectTimeout = 5 * time.Second
	connection.RuntimeParams = map[string]string{"application_name": "ax-execution-controller", "search_path": pgx.Identifier{config.Schema}.Sanitize() + ",pg_catalog", "statement_timeout": "5000"}
	poolConfig.MinConns = 0
	poolConfig.MaxConns = 3
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, errors.New("database_connect_failed")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("database_connect_failed")
	}
	return &Postgres{pool: pool, controllerID: controllerID, schema: config.Schema}, nil
}

func (p *Postgres) Close() { p.pool.Close() }
func (p *Postgres) query(name string) string {
	return "select " + pgx.Identifier{p.schema, name}.Sanitize()
}
func (p *Postgres) Claim(ctx context.Context) (*Claim, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var data []byte
	if err := p.pool.QueryRow(ctx, p.query("ax_claim")+"($1,$2)", p.controllerID, 30).Scan(&data); err != nil {
		return nil, errors.New("database_claim_failed")
	}
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil, nil
	}
	if len(data) > 1024*1024 {
		return nil, errors.New("invalid_database_claim")
	}
	var claim Claim
	if json.Unmarshal(data, &claim) != nil || claim.Request.Validate() != nil {
		return nil, errors.New("invalid_database_claim")
	}
	var requestWire struct {
		Request json.RawMessage `json:"request"`
		Agent   json.RawMessage `json:"agent"`
	}
	if json.Unmarshal(data, &requestWire) != nil {
		return nil, errors.New("invalid_database_claim")
	}
	request, err := native.ParseRequest(requestWire.Request)
	if err != nil {
		return nil, errors.New("invalid_database_claim")
	}
	claim.Request = request
	if request.Adapter == "interactive" {
		var agent gateway.Agent
		if native.DecodeStrict(requestWire.Agent, &agent) != nil || !agent.Valid() {
			return nil, errors.New("invalid_database_claim")
		}
		claim.Agent = &agent
	} else if claim.Agent != nil {
		return nil, errors.New("invalid_database_claim")
	}
	return &claim, nil
}
func (p *Postgres) Heartbeat(ctx context.Context, c *Claim) error {
	return p.exec(ctx, "ax_heartbeat", "($1,$2,$3,$4)", c.RunID, c.Generation, p.controllerID, 30)
}
func (p *Postgres) Intent(ctx context.Context, c *Claim, operation native.Operation) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var data []byte
	if err := p.pool.QueryRow(ctx, p.query("ax_intent")+"($1,$2,$3,$4)", c.RunID, c.Generation, p.controllerID, string(operation)).Scan(&data); err != nil {
		return "", classifyIntentError(err)
	}
	var result struct {
		OperationID string `json:"operation_id"`
	}
	if json.Unmarshal(data, &result) != nil || result.OperationID == "" {
		return "", errors.New("invalid_database_intent")
	}
	return result.OperationID, nil
}
func (p *Postgres) Evidence(ctx context.Context, c *Claim, operationID string, evidence map[string]any) error {
	data, err := json.Marshal(evidence)
	if err != nil {
		return errors.New("invalid_evidence")
	}
	return p.exec(ctx, "ax_evidence", "($1,$2,$3,$4,$5::jsonb)", c.RunID, c.Generation, p.controllerID, operationID, string(data))
}
func (p *Postgres) Collect(ctx context.Context, c *Claim, collection native.Collection) error {
	if collection.Result.Validate(c.Request) != nil {
		return errors.New("invalid_result")
	}
	data, err := json.Marshal(collection.Result)
	if err != nil {
		return errors.New("invalid_result")
	}
	return p.exec(ctx, "ax_collect", "($1,$2,$3,$4::jsonb,$5::bytea)", c.RunID, c.Generation, p.controllerID, string(data), collection.Bytes)
}
func (p *Postgres) Finish(ctx context.Context, c *Claim) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var data []byte
	if err := p.pool.QueryRow(ctx, p.query(finishFunction(c))+"($1,$2,$3)", c.RunID, c.Generation, p.controllerID).Scan(&data); err != nil {
		return errors.New("database_finish_unconfirmed")
	}
	var result struct {
		Resolved *bool  `json:"resolved"`
		Outcome  string `json:"outcome"`
	}
	if json.Unmarshal(data, &result) != nil || result.Resolved == nil || !validFinishOutcome(c, result.Outcome) {
		return errors.New("invalid_finish_result")
	}
	if !*result.Resolved {
		return ErrHeld
	}
	return nil
}
func (p *Postgres) Fail(ctx context.Context, c *Claim, code string) error {
	return p.exec(ctx, "ax_fail", "($1,$2,$3,$4)", c.RunID, c.Generation, p.controllerID, code)
}
func (p *Postgres) exec(ctx context.Context, name, args string, values ...any) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := p.pool.Exec(ctx, p.query(name)+args, values...)
	if err != nil {
		return errors.New("database_operation_unconfirmed")
	}
	return nil
}

func classifyIntentError(err error) error {
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && databaseError.Code == "P0001" && databaseError.Message == "workspace_access_revoked" {
		return ErrAuthorizationRevoked
	}
	if errors.As(err, &databaseError) && databaseError.Code == "P0001" {
		switch databaseError.Message {
		case "agent_stopped", "agent_grant_expired", "agent_budget_exhausted", "pilot_estimate_limit_reached":
			return ErrGatewayDenied
		}
	}
	return errors.New("database_intent_unconfirmed")
}

func (p *Postgres) Reserve(ctx context.Context, c *Claim, mailbox *native.Mailbox) (Reservation, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var data []byte
	if err := p.pool.QueryRow(ctx, p.query("ax_agent_reserve")+"($1,$2,$3,$4,$5::bytea)", c.RunID, c.Generation, p.controllerID, mailbox.Request.Sequence, mailbox.Bytes).Scan(&data); err != nil {
		return Reservation{}, classifyIntentError(err)
	}
	return parseReservation(data, c, mailbox)
}

func parseReservation(data []byte, c *Claim, mailbox *native.Mailbox) (Reservation, error) {
	var wire struct {
		Send        *bool            `json:"send"`
		Response    *json.RawMessage `json:"response"`
		InputLimit  int              `json:"input_limit"`
		OutputLimit int              `json:"output_limit"`
		ProfileID   string           `json:"profile_id"`
	}
	if native.DecodeStrict(data, &wire) != nil || wire.Send == nil || c.Agent == nil || wire.ProfileID != c.Agent.ProfileID || wire.InputLimit < 0 || wire.InputLimit > 6000 || wire.OutputLimit < 0 || wire.OutputLimit > 256 {
		return Reservation{}, errors.New("invalid_gateway_reservation")
	}
	response := json.RawMessage("null")
	if wire.Response != nil {
		response = *wire.Response
	}
	if *wire.Send {
		if wire.Response != nil {
			return Reservation{}, errors.New("invalid_gateway_reservation")
		}
	} else if _, err := native.ParseReply(response, mailbox); err != nil {
		return Reservation{}, errors.New("invalid_gateway_reservation")
	}
	return Reservation{Send: *wire.Send, Response: response, InputLimit: wire.InputLimit, OutputLimit: wire.OutputLimit, ProfileID: wire.ProfileID}, nil
}
func (p *Postgres) AuthorizeGeneration(ctx context.Context, c *Claim, mailbox *native.Mailbox, sha string, count int) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var data []byte
	if err := p.pool.QueryRow(ctx, p.query("ax_agent_authorize_generation")+"($1,$2,$3,$4,$5,$6)", c.RunID, c.Generation, p.controllerID, mailbox.Request.Sequence, sha, count).Scan(&data); err != nil {
		return classifyIntentError(err)
	}
	var result struct {
		Send bool `json:"send"`
	}
	if native.DecodeStrict(data, &result) != nil || !result.Send {
		return errors.New("model_authorization_unknown")
	}
	return nil
}
func (p *Postgres) Settle(ctx context.Context, c *Claim, mailbox *native.Mailbox, reply []byte, usage map[string]float64, elapsedMS int, evidence gateway.Evidence) error {
	if _, err := native.ParseReply(reply, mailbox); err != nil {
		return errors.New("invalid_gateway_response")
	}
	data, err := json.Marshal(usage)
	if err != nil {
		return errors.New("invalid_gateway_usage")
	}
	proof, err := json.Marshal(evidence)
	if err != nil {
		return errors.New("invalid_gateway_evidence")
	}
	return p.exec(ctx, "ax_agent_settle", "($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb)", c.RunID, c.Generation, p.controllerID, mailbox.Request.Sequence, string(reply), string(data), elapsedMS, string(proof))
}

func finishFunction(c *Claim) string {
	if c.Kind == "execute" && len(c.Effects) == 0 {
		return "ax_cancel_unstarted"
	}
	return "ax_finish"
}

func validFinishOutcome(c *Claim, outcome string) bool {
	if finishFunction(c) == "ax_cancel_unstarted" {
		return outcome == "not_started"
	}
	return outcome == "succeeded" || outcome == "failed"
}
