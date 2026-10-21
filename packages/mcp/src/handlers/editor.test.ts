import { EDITOR_CASES } from "../testing/cases/editor";
import { roundTrip } from "../testing/roundtrip";

roundTrip("editor tools round-trip", EDITOR_CASES);
