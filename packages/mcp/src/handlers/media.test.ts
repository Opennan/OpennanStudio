import { MEDIA_CASES } from "../testing/cases/media";
import { roundTrip } from "../testing/roundtrip";

roundTrip("media, graphics, and effect tools round-trip", MEDIA_CASES);
