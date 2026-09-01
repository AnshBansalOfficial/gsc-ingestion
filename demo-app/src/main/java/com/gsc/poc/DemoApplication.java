package com.gsc.poc;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Entry point for the POC demo service.
 *
 * <p>This service exists to produce realistic application signals (alerts and errors)
 * that are shipped to AWS CloudWatch Logs. It deliberately contains a small defect in
 * {@link com.gsc.poc.service.InvoiceService} which the AI engineering agent is expected
 * to locate and fix.
 */
@SpringBootApplication
public class DemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
}
