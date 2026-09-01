package com.gsc.poc.service;

import com.gsc.poc.model.Invoice;
import com.gsc.poc.model.LineItem;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class InvoiceServiceTest {

    private final InvoiceService service = new InvoiceService();

    private static Invoice invoiceWithAmounts(int... amountsCents) {
        List<LineItem> items = new java.util.ArrayList<>();
        for (int i = 0; i < amountsCents.length; i++) {
            items.add(new LineItem("line-" + i, amountsCents[i]));
        }
        return new Invoice("INV-TEST", items);
    }

    @Test
    @DisplayName("totalCents sums every line item")
    void totalCentsSumsLineItems() {
        assertEquals(4500, service.totalCents(invoiceWithAmounts(1000, 2000, 1500)));
    }

    @Test
    @DisplayName("totalCents is zero for an invoice with no line items")
    void totalCentsIsZeroForEmptyInvoice() {
        assertEquals(0, service.totalCents(invoiceWithAmounts()));
    }

    @Test
    @DisplayName("averageLineItemCents returns the mean line amount")
    void averageLineItemCentsReturnsMean() {
        assertEquals(1500, service.averageLineItemCents(invoiceWithAmounts(1000, 2000)));
    }

    @Test
    @DisplayName("averageLineItemCents truncates toward zero on uneven division")
    void averageLineItemCentsTruncates() {
        assertEquals(1000, service.averageLineItemCents(invoiceWithAmounts(1000, 1001)));
    }

    @Test
    @DisplayName("summarise renders the invoice id, count, total and average")
    void summariseRendersInvoice() {
        String summary = service.summarise(invoiceWithAmounts(1000, 2000));
        assertEquals("INV-TEST: 2 item(s), total 3000 cents, average 1500 cents", summary);
    }
}
