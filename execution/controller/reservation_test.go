package controller

import (
	"strings"
	"testing"
)

func TestReservationStrictShapeAcceptsNullResponseForSend(t *testing.T) {
	_, s, e, _ := modelFixture(t)
	data := []byte(`{"send":true,"response":null,"input_limit":6000,"output_limit":256,"profile_id":"gemini-3.1-flash-lite-standard-2026-10-07-v1"}`)
	result, err := parseReservation(data, s.claim, e.mailbox)
	if err != nil || !result.Send || result.InputLimit != 6000 {
		t.Fatal("valid reservation rejected", result, err)
	}
	for _, bad := range []string{strings.Replace(string(data), `"send":true`, `"send":true,"send":false`, 1), strings.Replace(string(data), `"output_limit":256`, `"output_limit":null`, 1), strings.Replace(string(data), `"profile_id":`, `"unknown":0,"profile_id":`, 1)} {
		if _, err := parseReservation([]byte(bad), s.claim, e.mailbox); err == nil {
			t.Fatal("invalid reservation accepted")
		}
	}
}
