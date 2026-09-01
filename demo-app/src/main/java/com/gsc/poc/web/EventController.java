package com.gsc.poc.web;

import com.gsc.poc.model.Invoice;
import com.gsc.poc.service.InvoiceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Endpoints the demo frontend uses to generate application signals.
 *
 * <p>Neither endpoint knows anything about the AI workflow. They only produce log
 * events. Everything downstream is driven by what lands in CloudWatch Logs.
 */
@RestController
@RequestMapping("/api")
public class EventController {

    private static final Logger log = LoggerFactory.getLogger(EventController.class);

    private final InvoiceService invoiceService;
    private final String orchestratorUrl;

    public EventController(InvoiceService invoiceService,
                           @Value("${poc.orchestrator-url}") String orchestratorUrl) {
        this.invoiceService = invoiceService;
        this.orchestratorUrl = orchestratorUrl;
    }

    /**
     * Emits an operational alert. Alerts describe degraded conditions that a human should
     * know about but that do not imply a code defect, so they must not start the agent.
     */
    @PostMapping("/alert")
    public Map<String, String> triggerAlert() {
        String incidentId = newIncidentId();
        MDC.put("incidentId", incidentId);
        try {
            log.warn("ALERT payment gateway latency degraded: p99=2350ms threshold=1200ms region=ap-south-1");
            return Map.of("incidentId", incidentId, "type", "ALERT",
                    "detail", "Alert log emitted to CloudWatch");
        } finally {
            MDC.remove("incidentId");
        }
    }

    /**
     * Exercises the billing summary path for a draft invoice that has no line items yet.
     * This is the code path containing the defect the agent is expected to fix.
     */
    @PostMapping("/error")
    public ResponseEntity<Map<String, String>> triggerError() {
        String incidentId = newIncidentId();
        MDC.put("incidentId", incidentId);
        try {
            Invoice draft = new Invoice("INV-1042", List.of());
            String summary = invoiceService.summarise(draft);

            log.info("Billing summary generated: {}", summary);
            return ResponseEntity.ok(Map.of("incidentId", incidentId, "type", "OK",
                    "detail", summary));
        } catch (RuntimeException ex) {
            log.error("Failed to build billing summary for invoice INV-1042", ex);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("incidentId", incidentId, "type", "ERROR",
                            "detail", ex.getClass().getSimpleName() + ": " + ex.getMessage()));
        } finally {
            MDC.remove("incidentId");
        }
    }

    /** Lets the static frontend discover where the orchestrator's status API lives. */
    @GetMapping("/config")
    public Map<String, String> config() {
        return Map.of("orchestratorUrl", orchestratorUrl);
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "UP");
    }

    private String newIncidentId() {
        return "INC-" + UUID.randomUUID().toString().substring(0, 8);
    }
}
